import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import QRCode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar variables de entorno locales si existen
const localEnvPath = path.resolve(__dirname, '../apps/web/.env.local');
if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath });
} else {
    dotenv.config();
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3005;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mfjtugukizpdmnzkjutn.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1manR1Z3VraXpwZG1uemtqdXRuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODcxODIzNywiZXhwIjoyMTA0Mjk0MjM3fQ.U72oRuO9VsZKdrtA-O6DGa_0-DXBNIaRa6MRB8zaYfw';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Almacén de instancias activas de WhatsApp
const sessions = new Map();
const qrCodes = new Map();
const sessionStatuses = new Map();
const reconnectAttempts = new Map();
const sendQueues = new Map();
const recentLogs = [];

// Helper para cola de envío con retardo humano (Anti-Ban / Rate Limiting)
async function enqueueOutboundSend(orgId, sendFn) {
    if (!sendQueues.has(orgId)) {
        sendQueues.set(orgId, Promise.resolve());
    }
    const previous = sendQueues.get(orgId);
    const current = previous.then(async () => {
        const result = await sendFn();
        // Pausa aleatoria entre mensajes consecutivos (1.5s a 3.5s)
        const jitter = 1500 + Math.floor(Math.random() * 2000);
        await new Promise(r => setTimeout(r, jitter));
        return result;
    });
    sendQueues.set(orgId, current.catch(() => {}));
    return current;
}

// Mapeo bidireccional LID <-> Teléfono Real
const lidToPhoneMap = new Map();
const phoneToLidMap = new Map();

function getValidOrgUuid(id) {
    if (!id) return 'a1000000-0000-0000-0000-000000000001';
    const match = String(id).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : 'a1000000-0000-0000-0000-000000000001';
}

function registerContact(c) {
    if (!c) return;
    const phoneJid = c.id || '';
    const lidJid = c.lid || '';
    const cleanPhone = phoneJid.includes('@s.whatsapp.net') ? phoneJid.replace(/[^0-9]/g, '') : '';
    const cleanLid = lidJid.includes('@lid') ? lidJid.replace(/[^0-9]/g, '') : (phoneJid.includes('@lid') ? phoneJid.replace(/[^0-9]/g, '') : '');
    
    if (cleanPhone && cleanLid && cleanPhone !== cleanLid) {
        lidToPhoneMap.set(cleanLid, cleanPhone);
        phoneToLidMap.set(cleanPhone, cleanLid);
    }
}

function logEvent(type, data) {
    const entry = { time: new Date().toISOString(), type, data };
    recentLogs.unshift(entry);
    if (recentLogs.length > 50) recentLogs.pop();
    console.log(`[${entry.time}] [${type}]`, typeof data === 'object' ? JSON.stringify(data) : data);
}

const logger = pino({ level: 'silent' });

// Health check para Railway
app.get('/', (req, res) => {
    return res.status(200).json({ status: 'active', engine: 'Baileys WhatsApp Realtime', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    return res.status(200).send('OK');
});

app.get('/api/logs', (req, res) => {
    return res.json({
        total: recentLogs.length,
        logs: recentLogs,
        sessions: Array.from(sessions.keys()).map(k => ({
            orgId: k,
            status: sessionStatuses.get(k),
            user: sessions.get(k)?.user
        }))
    });
});

// Helper para extraer texto de cualquier formato de mensaje WhatsApp
function extractMessageText(msg) {
    if (!msg || !msg.message) return null;

    // Ignorar paquetes internos de protocolo y cifrado
    if (msg.message.protocolMessage || 
        msg.message.senderKeyDistributionMessage || 
        msg.message.fastRatchetKeyDistributionMessage ||
        msg.message.keyExchangeMessage) {
        return null;
    }

    const m = msg.message.ephemeralMessage?.message ||
              msg.message.viewOnceMessage?.message ||
              msg.message.viewOnceMessageV2?.message ||
              msg.message.documentWithCaptionMessage?.message ||
              msg.message;

    return m?.conversation ||
           m?.extendedTextMessage?.text ||
           m?.imageMessage?.caption ||
           m?.videoMessage?.caption ||
           m?.documentMessage?.caption ||
           m?.templateMessage?.hydratedTemplate?.hydratedContentText ||
           m?.templateButtonReplyMessage?.selectedDisplayText ||
           m?.buttonsResponseMessage?.selectedDisplayText ||
           m?.listResponseMessage?.title ||
           m?.interactiveMessage?.body?.text ||
           (m?.imageMessage ? '[Imagen]' : '') ||
           (m?.videoMessage ? '[Video]' : '') ||
           (m?.audioMessage ? '[Audio]' : '') ||
           (m?.documentMessage ? '[Documento]' : '') ||
           null;
}

// Helper para normalizar números de teléfono (ej. Chile 9XXXXXXXX -> 569XXXXXXXX)
function normalizePhoneNumber(phone) {
    if (!phone) return '';
    let clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.length === 9 && clean.startsWith('9')) {
        clean = '56' + clean;
    } else if (clean.length === 8) {
        clean = '569' + clean;
    }
    return clean;
}

function cleanSessionFolder(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            try {
                if (fs.statSync(filePath).isDirectory()) {
                    cleanSessionFolder(filePath);
                    try { fs.rmdirSync(filePath); } catch (e) {}
                } else {
                    fs.unlinkSync(filePath);
                }
            } catch (e) {}
        }
    } catch (e) {}
}

async function initWhatsAppSession(orgId = 'a1000000-0000-0000-0000-000000000001', forceNew = false) {
    if (!forceNew && sessions.has(orgId) && sessionStatuses.get(orgId) === 'CONNECTED') {
        return sessions.get(orgId);
    }

    // Limpiar socket anterior si existía
    if (sessions.has(orgId)) {
        const oldSock = sessions.get(orgId);
        try { oldSock.end(undefined); } catch (e) {}
        sessions.delete(orgId);
    }

    sessionStatuses.set(orgId, 'INITIALIZING');
    qrCodes.delete(orgId);

    const sessionDir = path.resolve(__dirname, `./sessions/${orgId}`);
    if (forceNew) {
        cleanSessionFolder(sessionDir);
    }

    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: state,
        browser: ['Google Chrome (Windows)', 'Chrome', '124.0.0.0'],
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        getMessage: async () => undefined
    });

    sessions.set(orgId, sock);

    sock.ev.on('creds.update', saveCreds);

    // Sincronizar Contactos y Mapear LIDs a teléfonos reales
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of (contacts || [])) registerContact(c);
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const c of (updates || [])) registerContact(c);
    });

    sock.ev.on('messaging-history.set', ({ contacts }) => {
        for (const c of (contacts || [])) registerContact(c);
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        logEvent('connection.update', { connection, qr: Boolean(qr), statusCode: (lastDisconnect?.error)?.output?.statusCode });

        if (qr) {
            try {
                const qrImage = await QRCode.toDataURL(qr, { scale: 8, margin: 2 });
                qrCodes.set(orgId, qrImage);
                sessionStatuses.set(orgId, 'QR_READY');
                console.log(`[WhatsApp ${orgId}] 📲 Nuevo Código QR generado con éxito`);
            } catch (err) {
                console.error(`[WhatsApp ${orgId}] Error generando QR imagen:`, err);
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
            console.log(`[WhatsApp ${orgId}] ⚠️ Conexión cerrada. Status: ${statusCode}, isLoggedOut: ${isLoggedOut}`);
            
            sessionStatuses.set(orgId, 'DISCONNECTED');
            qrCodes.delete(orgId);
            sessions.delete(orgId);

            if (isLoggedOut) {
                // Borrar archivos de sesión para forzar nuevo QR limpio
                cleanSessionFolder(sessionDir);
                reconnectAttempts.delete(orgId);
            }

            // Actualizar Supabase
            try {
                const dbOrgId = getValidOrgUuid(orgId);
                await supabase.from('organizaciones').update({
                    whatsapp_status: 'DESCONECTADO',
                    whatsapp_phone: null,
                    updated_at: new Date().toISOString()
                }).eq('id', dbOrgId);
            } catch (e) {}

            // Reconexión con Backoff exponencial inteligente (evita saturación y shadowban)
            const attempts = (reconnectAttempts.get(orgId) || 0) + 1;
            reconnectAttempts.set(orgId, attempts);
            const delayMs = isLoggedOut ? 1500 : Math.min(attempts * 2500, 30000);
            
            console.log(`[WhatsApp ${orgId}] ⏳ Reintentando conexión en ${delayMs / 1000}s (Intento #${attempts})...`);
            setTimeout(() => initWhatsAppSession(orgId, isLoggedOut), delayMs);
        } else if (connection === 'open') {
            console.log(`[WhatsApp ${orgId}] ✅ ¡Conexión establecida con éxito!`);
            sessionStatuses.set(orgId, 'CONNECTED');
            qrCodes.delete(orgId);
            reconnectAttempts.set(orgId, 0);

            const userJid = sock.user?.id || '';
            const phone = userJid.split(':')[0] || userJid.split('@')[0];
            logEvent('connection.open', { phone, userJid });

            // Actualizar en Supabase
            try {
                const dbOrgId = getValidOrgUuid(orgId);
                await supabase.from('organizaciones').update({
                    whatsapp_status: 'CONECTADO',
                    whatsapp_phone: `+${phone}`,
                    updated_at: new Date().toISOString()
                }).eq('id', dbOrgId);
            } catch (e) {
                console.error('Error actualizando estado en Supabase:', e);
            }
        }
    });

    // Escuchar mensajes en tiempo real (entrantes y salientes)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        logEvent('messages.upsert', { type, count: messages?.length });

        for (const msg of (messages || [])) {
            if (!msg || !msg.message) continue;

            const from = msg.key?.remoteJid;
            if (!from || from.includes('@g.us') || from === 'status@broadcast') continue;

            const isFromMe = Boolean(msg.key?.fromMe);
            let rawId = from.replace(/[^0-9]/g, '');
            if (msg.key?.participant) {
                const partPhone = msg.key.participant.replace(/[^0-9]/g, '');
                if (partPhone) rawId = partPhone;
            }
            if (!rawId) continue;

            // Resolver si rawId es un LID a su número de teléfono real
            const isLid = from.endsWith('@lid') || rawId.length > 13;
            let phone = rawId;
            if (isLid && lidToPhoneMap.has(rawId)) {
                phone = lidToPhoneMap.get(rawId);
            }
            phone = normalizePhoneNumber(phone);

            const text = extractMessageText(msg);
            if (!text) continue; // Ignorar paquetes que no tienen texto de chat

            const senderName = msg.verifiedBizName || msg.pushName || (isFromMe ? 'Agente' : `+${phone}`);
            const myPhone = sock.user?.id ? `+${sock.user.id.split(':')[0]}` : '+56994340066';

            // Simular lectura humana (Double Blue Check) tras 1.5 a 3.5s si es mensaje entrante
            if (!isFromMe && msg.key) {
                setTimeout(async () => {
                    try {
                        await sock.readMessages([msg.key]);
                    } catch (e) {}
                }, 1500 + Math.floor(Math.random() * 2000));
            }

            logEvent('message.received', { from, rawId, phone, isLid, isFromMe, senderName, text });

            const dbOrgId = getValidOrgUuid(orgId);

            try {
                // 1. Buscar Lead existente por teléfono o JID o LID
                let leadId = null;
                const { data: existingLead, error: leadFindErr } = await supabase
                    .from('leads')
                    .select('id, nombre, estado, comentarios, metadata, telefono')
                    .eq('organizacion_id', dbOrgId)
                    .or(`telefono.ilike.%${phone.slice(-8)}%,telefono.eq.+${phone},telefono.eq.+${rawId}`)
                    .limit(1)
                    .maybeSingle();

                if (leadFindErr) {
                    logEvent('lead.find.error', { error: leadFindErr.message });
                }

                if (existingLead) {
                    leadId = existingLead.id;
                    const shouldUpdatePhone = phone !== rawId && existingLead.telefono.includes(rawId);
                    const updatePayload = {
                        ...(shouldUpdatePhone ? { telefono: `+${phone}` } : {}),
                        comentarios: isFromMe ? (existingLead.comentarios || text) : text,
                        metadata: { 
                            ...(existingLead.metadata || {}),
                            jid: from, 
                            lid: isLid ? from : (existingLead.metadata?.lid || null),
                            last_message: text,
                            last_message_at: new Date().toISOString(),
                            last_message_direction: isFromMe ? 'outbound' : 'inbound',
                            unread: !isFromMe,
                            ...(isFromMe ? {} : { last_inbound_message: text, last_inbound_at: new Date().toISOString() })
                        },
                        updated_at: new Date().toISOString()
                    };

                    if (!isFromMe && (msg.verifiedBizName || msg.pushName) && (!existingLead.nombre || existingLead.nombre.startsWith('Cliente') || existingLead.nombre.startsWith('Contacto') || existingLead.nombre.startsWith('Prospecto') || existingLead.nombre.startsWith('+'))) {
                        updatePayload.nombre = msg.verifiedBizName || msg.pushName;
                    }

                    const { error: leadUpErr } = await supabase.from('leads').update(updatePayload).eq('id', existingLead.id);
                    if (leadUpErr) logEvent('lead.update.error', { error: leadUpErr.message });
                } else if (!isFromMe) {
                    // Auto-crear Lead SOLO si es mensaje entrante de un cliente nuevo
                    const { data: newLead, error: leadInsErr } = await supabase.from('leads').insert({
                        organizacion_id: dbOrgId,
                        nombre: senderName,
                        telefono: `+${phone}`,
                        estado: 'BANDEJA DE ENTRADA',
                        fuente: 'WhatsApp Directo',
                        comentarios: text,
                        metadata: { 
                            jid: from, 
                            lid: isLid ? from : null,
                            last_message: text,
                            last_inbound_message: text,
                            last_message_at: new Date().toISOString(),
                            last_inbound_at: new Date().toISOString(),
                            last_message_direction: 'inbound',
                            unread: true
                        }
                    }).select('id').single();

                    if (leadInsErr) {
                        logEvent('lead.insert.error', { error: leadInsErr.message });
                    } else if (newLead) {
                        leadId = newLead.id;
                        logEvent('lead.created', { id: leadId, nombre: senderName });
                    }
                }

                // 2. Guardar mensaje en whatsapp_messages
                const { data: msgData, error: msgInsErr } = await supabase.from('whatsapp_messages').insert({
                    organizacion_id: dbOrgId,
                    lead_id: leadId,
                    sender: isFromMe ? myPhone : `+${phone}`,
                    receiver: isFromMe ? `+${phone}` : myPhone,
                    message_text: text,
                    direction: isFromMe ? 'outbound' : 'inbound',
                    status: isFromMe ? 'sent' : 'received'
                }).select('id');

                if (msgInsErr) {
                    logEvent('msg.insert.error', { error: msgInsErr.message });
                } else {
                    logEvent('msg.inserted', { id: msgData?.[0]?.id, text });
                }
            } catch (err) {
                logEvent('message.process.exception', { error: err.message });
                console.error(`[WhatsApp ${orgId}] Error procesando mensaje:`, err);
            }
        }
    });

    return sock;
}

// ENDPOINTS REST PARA EL CRM FRONTEND

// 1. Obtener QR / Estado de la instancia
app.get('/api/instance/:orgId/qr', async (req, res) => {
    const { orgId } = req.params;
    
    const currentStatus = sessionStatuses.get(orgId);
    const existingQr = qrCodes.get(orgId);
    const existingSock = sessions.get(orgId);

    // Si no está conectado y no hay QR listo, forzar inicio de sesión limpio para generar el QR
    if (!existingSock || currentStatus === 'DISCONNECTED' || (currentStatus !== 'CONNECTED' && !existingQr)) {
        await initWhatsAppSession(orgId, true);
        
        // Esperar hasta 4 segundos a que Baileys emita el código QR
        for (let i = 0; i < 20; i++) {
            if (qrCodes.get(orgId) || sessionStatuses.get(orgId) === 'CONNECTED') break;
            await new Promise(r => setTimeout(r, 200));
        }
    }

    const qr = qrCodes.get(orgId);
    const status = sessionStatuses.get(orgId) || 'INITIALIZING';
    const sock = sessions.get(orgId);
    const isConnected = status === 'CONNECTED';
    const phone = (isConnected && sock?.user?.id) ? `+${sock.user.id.split(':')[0]}` : null;

    return res.json({
        success: true,
        orgId,
        status: qr ? 'QR_READY' : status,
        qrCode: qr || null,
        phone
    });
});

// 2. Enviar mensaje de WhatsApp
app.post('/api/instance/:orgId/send', async (req, res) => {
    const { orgId } = req.params;
    const { to, message, leadId: reqLeadId } = req.body;

    if (!to || !message) {
        return res.status(400).json({ error: 'Faltan parámetros (to, message)' });
    }

    const sock = sessions.get(orgId);
    if (!sock || sessionStatuses.get(orgId) !== 'CONNECTED') {
        return res.status(400).json({ error: 'WhatsApp no está conectado para esta organización' });
    }

    try {
        let cleanPhone = normalizePhoneNumber(to);
        let targetJid = to.includes('@') ? to : null;

        // Si es LID largo, revisar si conocemos el teléfono real
        if (cleanPhone.length > 13 && lidToPhoneMap.has(cleanPhone)) {
            cleanPhone = lidToPhoneMap.get(cleanPhone);
        }

        // Buscar Lead para vincular y obtener su JID real si existe
        let leadId = reqLeadId || null;
        let leadData = null;

        if (leadId) {
            const { data } = await supabase
                .from('leads')
                .select('id, metadata, telefono')
                .eq('id', leadId)
                .maybeSingle();
            leadData = data;
        }

        const dbOrgId = getValidOrgUuid(orgId);

        if (!leadData) {
            const { data } = await supabase
                .from('leads')
                .select('id, metadata, telefono')
                .eq('organizacion_id', dbOrgId)
                .or(`telefono.ilike.%${cleanPhone.slice(-8)}%,telefono.eq.+${cleanPhone}`)
                .limit(1)
                .maybeSingle();
            leadData = data;
        }

        if (leadData) {
            leadId = leadData.id;
            if (leadData.metadata?.jid && !to.includes('@')) {
                targetJid = leadData.metadata.jid;
            }
        }

        if (!targetJid) {
            if (cleanPhone.length > 13) {
                targetJid = `${cleanPhone}@lid`;
            } else {
                // Validar contra servidores de WhatsApp
                try {
                    const results = await sock.onWhatsApp(cleanPhone);
                    if (results && results.length > 0 && results[0]?.exists && results[0]?.jid) {
                        targetJid = results[0].jid;
                    } else {
                        targetJid = `${cleanPhone}@s.whatsapp.net`;
                    }
                } catch (e) {
                    targetJid = `${cleanPhone}@s.whatsapp.net`;
                }
            }
        }

        logEvent('message.send.attempt', { targetJid, cleanPhone, message, leadId });

        // Enviar a través de la cola con simulación de comportamiento humano (Anti-Ban)
        const sendResult = await enqueueOutboundSend(orgId, async () => {
            // 1. Simular estado "Escribiendo..." proporcional al tamaño del mensaje (1.2s a 3.2s)
            try {
                await sock.sendPresenceUpdate('composing', targetJid);
            } catch (e) {}

            const typingDurationMs = Math.min(Math.max(message.length * 25, 1200), 3200);
            await new Promise(r => setTimeout(r, typingDurationMs));

            // 2. Enviar mensaje real
            let sent;
            try {
                sent = await sock.sendMessage(targetJid, { text: message });
            } catch (sendErr) {
                console.warn(`[WhatsApp ${orgId}] Error enviando a ${targetJid}, intentando formato alternativo:`, sendErr.message);
                const altJid = targetJid.endsWith('@lid') ? `${cleanPhone}@s.whatsapp.net` : `${cleanPhone}@lid`;
                sent = await sock.sendMessage(altJid, { text: message });
                targetJid = altJid;
            }

            // 3. Pausar estado de presencia
            try {
                await sock.sendPresenceUpdate('paused', targetJid);
            } catch (e) {}

            return sent;
        });

        const myPhone = sock.user?.id ? `+${sock.user.id.split(':')[0]}` : '+56994340066';
        logEvent('message.send.success', { targetJid, messageId: sendResult?.key?.id });

        // Guardar mensaje saliente en Supabase
        await supabase.from('whatsapp_messages').insert({
            organizacion_id: dbOrgId,
            lead_id: leadId,
            sender: myPhone,
            receiver: `+${cleanPhone}`,
            message_text: message,
            direction: 'outbound',
            status: 'sent'
        });

        // Actualizar último mensaje en el Lead y marcar como leído/respondido
        if (leadId) {
            await supabase.from('leads').update({
                comentarios: message,
                metadata: {
                    ...(leadData?.metadata || {}),
                    last_message: message,
                    last_message_at: new Date().toISOString(),
                    last_message_direction: 'outbound',
                    unread: false
                },
                updated_at: new Date().toISOString()
            }).eq('id', leadId);
        }

        return res.json({ success: true, messageId: sendResult?.key?.id });
    } catch (err) {
        console.error('Error enviando mensaje:', err);
        return res.status(500).json({ error: err.message });
    }
});

// 3. Desconectar sesión
app.post('/api/instance/:orgId/logout', async (req, res) => {
    const { orgId } = req.params;
    const sock = sessions.get(orgId);

    if (sock) {
        try { await sock.logout(); } catch (e) {}
        try { sock.end(undefined); } catch (e) {}
        sessions.delete(orgId);
        qrCodes.delete(orgId);
        sessionStatuses.set(orgId, 'DISCONNECTED');
    }

    const sessionDir = path.resolve(__dirname, `./sessions/${orgId}`);
    cleanSessionFolder(sessionDir);

    try {
        const dbOrgId = getValidOrgUuid(orgId);
        await supabase.from('organizaciones').update({
            whatsapp_status: 'DESCONECTADO',
            whatsapp_phone: null,
            updated_at: new Date().toISOString()
        }).eq('id', dbOrgId);
    } catch (e) {}

    setTimeout(() => {
        initWhatsAppSession(orgId, true).catch(() => {});
    }, 800);

    return res.json({ success: true, status: 'DISCONNECTED' });
});

// 4. Reiniciar sesión y forzar generación de nuevo QR
app.get('/api/instance/:orgId/reset', async (req, res) => {
    const { orgId } = req.params;
    const sessionDir = path.resolve(__dirname, `./sessions/${orgId}`);
    cleanSessionFolder(sessionDir);
    sessionStatuses.set(orgId, 'DISCONNECTED');
    qrCodes.delete(orgId);
    if (sessions.has(orgId)) {
        try { sessions.get(orgId).end(undefined); } catch (e) {}
        sessions.delete(orgId);
    }
    await initWhatsAppSession(orgId, true);
    for (let i = 0; i < 20; i++) {
        if (qrCodes.get(orgId)) break;
        await new Promise(r => setTimeout(r, 200));
    }
    return res.json({
        success: true,
        qrCode: qrCodes.get(orgId) || null,
        status: qrCodes.get(orgId) ? 'QR_READY' : (sessionStatuses.get(orgId) || 'INITIALIZING')
    });
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`=========================================`);
    console.log(`🚀 WhatsApp Baileys Engine corriendo en 0.0.0.0:${PORT}`);
    console.log(`=========================================`);
    try {
        await initWhatsAppSession('a1000000-0000-0000-0000-000000000001');
    } catch (e) {
        console.error('Error auto-iniciando sesión en boot:', e);
    }
});
