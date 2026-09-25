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
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Almacén de instancias activas de WhatsApp
const sessions = new Map();
const qrCodes = new Map();
const sessionStatuses = new Map();

const logger = pino({ level: 'silent' });

// Health check para Railway
app.get('/', (req, res) => {
    return res.status(200).json({ status: 'active', engine: 'Baileys WhatsApp Realtime', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    return res.status(200).send('OK');
});

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
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

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

    // Escuchar mensajes entrantes en tiempo real
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            if (!from || from.includes('@g.us')) continue; // ignorar grupos por ahora

            const phone = from.replace(/[^0-9]/g, '');
            const senderName = msg.pushName || `Cliente WhatsApp (${phone.slice(-4)})`;
            const text = msg.message?.conversation || 
                         msg.message?.extendedTextMessage?.text || 
                         msg.message?.imageMessage?.caption || 
                         '[Archivo / Multimedia]';

            console.log(`[WhatsApp ${orgId}] 💬 Mensaje entrante de ${senderName} (+${phone}): ${text}`);

            try {
                // 1. Guardar mensaje en whatsapp_messages
                await supabase.from('whatsapp_messages').insert({
                    organizacion_id: orgId,
                    phone: `+${phone}`,
                    sender_name: senderName,
                    message_text: text,
                    direction: 'inbound',
                    status: 'received',
                    raw_payload: msg
                });

                // 2. Verificar o crear Lead en leads
                const { data: existingLead } = await supabase
                    .from('leads')
                    .select('id, estado')
                    .eq('organizacion_id', orgId)
                    .ilike('telefono', `%${phone.slice(-8)}%`)
                    .maybeSingle();

                if (existingLead) {
                    await supabase.from('leads').update({
                        last_message: text,
                        updated_at: new Date().toISOString()
                    }).eq('id', existingLead.id);
                } else {
                    await supabase.from('leads').insert({
                        organizacion_id: orgId,
                        nombre: senderName,
                        telefono: `+${phone}`,
                        estado: 'NUEVO_LEAD',
                        origen: 'WhatsApp QR',
                        last_message: text,
                        prioridad: 'MEDIA'
                    });
                    console.log(`[WhatsApp ${orgId}] 🎯 Nuevo Lead auto-creado en Kanban: ${senderName}`);
                }
            } catch (err) {
                console.error(`[WhatsApp ${orgId}] Error procesando mensaje entrante:`, err);
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

        // Guardar mensaje saliente en Supabase
        await supabase.from('whatsapp_messages').insert({
            organizacion_id: orgId,
            phone: `+${cleanPhone}`,
            sender_name: 'Agente CRM',
            message_text: message,
            direction: 'outbound',
            status: 'sent',
            raw_payload: sent
        });

        return res.json({ success: true, messageId: sent.key.id });
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🚀 WhatsApp Baileys Engine corriendo en 0.0.0.0:${PORT}`);
    console.log(`=========================================`);
});
