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
const recentLogs = [];

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
    if (!msg || !msg.message) return '';
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
           m?.templateButtonReplyMessage?.selectedDisplayText ||
           m?.buttonsResponseMessage?.selectedDisplayText ||
           m?.listResponseMessage?.title ||
           (m?.imageMessage ? '[Imagen]' : '') ||
           (m?.videoMessage ? '[Video]' : '') ||
           (m?.audioMessage ? '[Audio]' : '') ||
           (m?.documentMessage ? '[Documento]' : '') ||
           '[Mensaje WhatsApp]';
}

async function initWhatsAppSession(orgId = 'a1000000-0000-0000-0000-000000000001') {
    if (sessions.has(orgId)) {
        return sessions.get(orgId);
    }

    const sessionDir = path.resolve(__dirname, `./sessions/${orgId}`);
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
        browser: ['Webhook CRM SaaS', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            return undefined;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        logEvent('connection.update', { connection, qr: Boolean(qr), statusCode: (lastDisconnect?.error)?.output?.statusCode });

        if (qr) {
            try {
                const qrImage = await QRCode.toDataURL(qr, { scale: 8, margin: 2 });
                qrCodes.set(orgId, qrImage);
                sessionStatuses.set(orgId, 'QR_READY');
                console.log(`[WhatsApp ${orgId}] 📲 Nuevo Código QR generado`);
            } catch (err) {
                console.error(`[WhatsApp ${orgId}] Error generando QR imagen:`, err);
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[WhatsApp ${orgId}] ⚠️ Conexión cerrada. Reconectar: ${shouldReconnect}, Status: ${statusCode}`);
            
            sessionStatuses.set(orgId, 'DISCONNECTED');
            qrCodes.delete(orgId);
            sessions.delete(orgId);

            // Actualizar Supabase
            try {
                await supabase.from('organizaciones').update({
                    whatsapp_status: 'DESCONECTADO',
                    updated_at: new Date().toISOString()
                }).eq('id', orgId);
            } catch (e) {}

            if (shouldReconnect) {
                setTimeout(() => initWhatsAppSession(orgId), 3000);
            }
        } else if (connection === 'open') {
            console.log(`[WhatsApp ${orgId}] ✅ ¡Conexión establecida con éxito!`);
            sessionStatuses.set(orgId, 'CONNECTED');
            qrCodes.delete(orgId);

            const userJid = sock.user?.id || '';
            const phone = userJid.split(':')[0] || userJid.split('@')[0];
            logEvent('connection.open', { phone, userJid });

            // Actualizar en Supabase
            try {
                await supabase.from('organizaciones').update({
                    whatsapp_status: 'CONECTADO',
                    whatsapp_phone: `+${phone}`,
                    updated_at: new Date().toISOString()
                }).eq('id', orgId);
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
            const phone = from.replace(/[^0-9]/g, '');
            if (!phone) continue;

            const senderName = msg.pushName || (isFromMe ? 'Agente' : `Cliente (+${phone.slice(-4)})`);
            const text = extractMessageText(msg);
            const myPhone = sock.user?.id ? `+${sock.user.id.split(':')[0]}` : '+56994340066';

            logEvent('message.received', { from, phone, isFromMe, senderName, text });

            try {
                // 1. Buscar Lead existente por teléfono
                let leadId = null;
                const { data: existingLead, error: leadFindErr } = await supabase
                    .from('leads')
                    .select('id, estado, comentarios')
                    .eq('organizacion_id', orgId)
                    .or(`telefono.ilike.%${phone.slice(-8)}%,telefono.eq.+${phone}`)
                    .limit(1)
                    .maybeSingle();

                if (leadFindErr) {
                    logEvent('lead.find.error', { error: leadFindErr.message });
                }

                if (existingLead) {
                    leadId = existingLead.id;
                    const { error: leadUpErr } = await supabase.from('leads').update({
                        comentarios: text,
                        metadata: { last_message: text },
                        updated_at: new Date().toISOString()
                    }).eq('id', existingLead.id);
                    if (leadUpErr) logEvent('lead.update.error', { error: leadUpErr.message });
                } else if (!isFromMe) {
                    // Auto-crear Lead si es entrante nuevo
                    const { data: newLead, error: leadInsErr } = await supabase.from('leads').insert({
                        organizacion_id: orgId,
                        nombre: senderName,
                        telefono: `+${phone}`,
                        estado: 'BANDEJA DE ENTRADA',
                        fuente: 'WhatsApp Directo',
                        comentarios: text,
                        metadata: { last_message: text }
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
                    organizacion_id: orgId,
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

    sessions.set(orgId, sock);
    return sock;
}

// ENDPOINTS REST PARA EL CRM FRONTEND

// 1. Obtener QR / Estado de la instancia
app.get('/api/instance/:orgId/qr', async (req, res) => {
    const { orgId } = req.params;
    
    // Iniciar sesión si no existe
    if (!sessions.has(orgId)) {
        await initWhatsAppSession(orgId);
    }

    const qr = qrCodes.get(orgId);
    const status = sessionStatuses.get(orgId) || 'INITIALIZING';
    const sock = sessions.get(orgId);
    const phone = sock?.user?.id ? `+${sock.user.id.split(':')[0]}` : null;

    return res.json({
        success: true,
        orgId,
        status,
        qrCode: qr || null,
        phone
    });
});

// 2. Enviar mensaje de WhatsApp
app.post('/api/instance/:orgId/send', async (req, res) => {
    const { orgId } = req.params;
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ error: 'Faltan parámetros (to, message)' });
    }

    const sock = sessions.get(orgId);
    if (!sock || sessionStatuses.get(orgId) !== 'CONNECTED') {
        return res.status(400).json({ error: 'WhatsApp no está conectado para esta organización' });
    }

    try {
        const cleanPhone = to.replace(/[^0-9]/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;

        const sent = await sock.sendMessage(jid, { text: message });
        const myPhone = sock.user?.id ? `+${sock.user.id.split(':')[0]}` : '+56994340066';

        // Buscar Lead para vincular
        let leadId = null;
        const { data: leadData } = await supabase
            .from('leads')
            .select('id')
            .eq('organizacion_id', orgId)
            .or(`telefono.ilike.%${cleanPhone.slice(-8)}%,telefono.eq.+${cleanPhone}`)
            .limit(1)
            .maybeSingle();
        if (leadData) leadId = leadData.id;

        // Guardar mensaje saliente en Supabase
        await supabase.from('whatsapp_messages').insert({
            organizacion_id: orgId,
            lead_id: leadId,
            sender: myPhone,
            receiver: `+${cleanPhone}`,
            message_text: message,
            direction: 'outbound',
            status: 'sent'
        });

        return res.json({ success: true, messageId: sent.key?.id });
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
        try {
            await sock.logout();
        } catch (e) {}
        sessions.delete(orgId);
        qrCodes.delete(orgId);
        sessionStatuses.set(orgId, 'DISCONNECTED');
    }

    return res.json({ success: true, status: 'DISCONNECTED' });
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
