// index.js (Versi Server Web Terintegrasi)

const express = require('express');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { 
    default: makeWASocket,
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const qrcode = require('qrcode');

// Inisialisasi Server Express
const app = express();
const PORT = process.env.PORT || 3000;

// Direktori untuk file statis (HTML, CSS, JS frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Map untuk menyimpan instance socket yang aktif berdasarkan ID Sesi
const activeSessions = new Map();

// Fungsi untuk membuat dan mengelola koneksi WhatsApp
async function createWhatsAppSession(sessionId, res) {
    // Path unik untuk setiap sesi
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const bot = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // QR akan dikirim ke frontend, bukan terminal
        browser: ["KnightBot-Web", "Chrome", "110.0.0.0"],
    });

    // Simpan instance bot ke map
    activeSessions.set(sessionId, bot);

    // Menyimpan kredensial
    bot.ev.on('creds.update', saveCreds);

    // Mengelola status koneksi
    bot.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Koneksi ditutup untuk sesi ${sessionId}, alasan: ${statusCode}`);
            
            // Hapus sesi dari map jika logout atau alasan lain yang tidak bisa di-recover
            if (statusCode !== DisconnectReason.loggedOut) {
                // Bisa ditambahkan logika untuk mencoba koneksi ulang di sini
            }
            activeSessions.delete(sessionId);
            // Anda bisa juga menghapus folder sesi jika diperlukan
            // fs.rmSync(sessionPath, { recursive: true, force: true });
        } else if (connection === 'open') {
            console.log(`Koneksi WhatsApp terbuka untuk sesi ${sessionId}`);
        }
    });

    // Mengirimkan pesan selamat datang setelah bot online (opsional)
    bot.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        console.log(`Pesan masuk dari ${msg.key.remoteJid}`);
        // Di sini Anda bisa menambahkan logika penanganan pesan dari file main.js Anda jika perlu
    });

    return bot;
}

// === API ENDPOINTS ===

// Endpoint untuk menyajikan halaman utama
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint untuk meminta Pairing Code (Versi lebih tangguh)
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.number;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Nomor telepon diperlukan' });
    }
    
    const sessionId = phoneNumber.replace(/[^0-9]/g, '');
    
    if (activeSessions.has(sessionId)) {
        return res.status(400).json({ error: 'Sesi untuk nomor ini sudah aktif atau sedang diproses.' });
    }

    try {
        const bot = await createWhatsAppSession(sessionId, res);

        // Menunggu koneksi benar-benar terbuka sebelum meminta pairing code
        const connectionPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                bot.ev.removeAllListeners('connection.update');
                activeSessions.delete(sessionId);
                reject(new Error('Timeout: Gagal terhubung ke WhatsApp dalam 30 detik.'));
            }, 30000);

            bot.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'open') {
                    clearTimeout(timeout);
                    bot.ev.removeAllListeners('connection.update');
                    resolve(true);
                } else if (connection === 'close') {
                    clearTimeout(timeout);
                    bot.ev.removeAllListeners('connection.update');
                    activeSessions.delete(sessionId);
                    reject(new Boom(lastDisconnect?.error));
                }
            });
        });

        await connectionPromise;

        const pairingCode = await bot.requestPairingCode(sessionId);
        const formattedCode = pairingCode?.match(/.{1,4}/g)?.join('-') || pairingCode;
        
        res.json({ code: formattedCode });
    } catch (error) {
        console.error(`Gagal membuat pairing code untuk ${sessionId}:`, error);
        activeSessions.delete(sessionId); // Bersihkan jika gagal
        res.status(500).json({ error: error.message || 'Gagal membuat pairing code. Coba lagi nanti.' });
    }
});

// Endpoint untuk meminta QR Code
app.get('/qr', async (req, res) => {
    // Gunakan ID sesi statis untuk login via QR
    const sessionId = 'qr-login-session';

    if (activeSessions.has(sessionId)) {
        return res.status(400).json({ error: 'Sesi QR sudah aktif. Silakan refresh halaman.' });
    }

    try {
        const bot = await createWhatsAppSession(sessionId);

        // Menggunakan Promise untuk menunggu QR code muncul
        const qrPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                bot.ev.removeAllListeners('connection.update');
                activeSessions.delete(sessionId);
                reject(new Error('Timeout: Gagal mendapatkan QR code dalam 60 detik.'));
            }, 60000);

            bot.ev.on('connection.update', async (update) => {
                const { qr } = update;
                if (qr) {
                    clearTimeout(timeout);
                    bot.ev.removeAllListeners('connection.update');
                    const qrUrl = await qrcode.toDataURL(qr);
                    resolve(qrUrl);
                }
            });
        });

        const qrUrl = await qrPromise;
        const instructions = [
            '1. Buka WhatsApp di ponsel Anda',
            '2. Ketuk Menu (tiga titik) > Perangkat tertaut',
            '3. Ketuk "Tautkan perangkat" dan pindai kode QR ini'
        ];
        res.json({ qr: qrUrl, instructions: instructions });

    } catch (error) {
        console.error('Gagal membuat QR code:', error);
        activeSessions.delete(sessionId); // Bersihkan jika gagal
        res.status(500).json({ error: error.message || 'Gagal membuat QR code.' });
    }
});


// Menjalankan server
app.listen(PORT, () => {
    console.log(`🚀 Server Knight Bot berjalan di http://localhost:${PORT}`);
    console.log(`Pastikan file index.html ada di dalam folder 'public'`);
});
