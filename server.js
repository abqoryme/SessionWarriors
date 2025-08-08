import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} from '@whiskeysockets/baileys';
import express from 'express';
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode';

const app = express();
const port = 3000;
const __dirname = path.resolve(path.dirname(''));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

process.on('uncaughtException', (err) => console.error('❌ Uncaught Exception:', err));
process.on('unhandledRejection', (reason, p) => console.error('❌ Unhandled Rejection at:', p, 'reason:', reason));

// Endpoint untuk Kode Pairing
app.get('/pair', async (req, res) => {
  const number = req.query.number;
  if (!number) {
    return res.status(400).json({ error: 'Nomor tidak boleh kosong.' });
  }
  const sessionPath = `auth_info_${number}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    //browser: Browsers.macOS('Chrome')
    browser: Browsers.ubuntu('Chrome')
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${number}] Koneksi ditutup. Kode: ${statusCode}`);
      if (statusCode === DisconnectReason.loggedOut) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`[${number}] Sesi dihapus karena logout.`);
      }
    }
    
    if (connection === 'open') {
      console.log(`[${number}] ✅ Terhubung ke WhatsApp!`);
    }
  });

  try {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const pairingCode = await sock.requestPairingCode(number);
    console.log(`[${number}] 🔗 Pairing Code: ${pairingCode}`);
    res.json({ success: true, code: pairingCode });
  } catch (err) {
    console.error(`[${number}] ❌ Gagal mendapatkan pairing code:`, err);
    res.status(500).json({ error: 'Gagal mendapatkan pairing code.', message: err.message });
  }
});

// Endpoint untuk Kode QR
app.get('/qr', async (req, res) => {
  console.log('Menerima permintaan untuk kode QR...');
  const sessionPath = 'auth_info_qr';
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    //browser: Browsers.macOS('Chrome')
    browser: Browsers.ubuntu('Chrome')
  });

  sock.ev.on('creds.update', saveCreds);
  const qrPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sock.end(new Error("Timeout saat menunggu QR"));
      reject(new Error('Timeout: Gagal mendapatkan QR code dalam 30 detik.'));
    }, 30000);
    sock.ev.on('connection.update', async (update) => {
      const { connection, qr } = update;
      if (qr) {
        clearTimeout(timeout);
        console.log('QR Code diterima, sedang dikonversi...');
        const qrImage = await qrcode.toDataURL(qr);
        resolve(qrImage);
        sock.end();
      }
      if (connection === 'close') {
        fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
          if (err) console.error("Gagal menghapus folder sesi QR:", err);
        });
      }
    });
  });

  try {
    const qrImage = await qrPromise;
    res.json({
      success: true,
      qr: qrImage,
      instructions: [
        "1. Buka WhatsApp di ponsel Anda.",
        "2. Ketuk Menu (⋮) atau Pengaturan dan pilih Perangkat Tertaut.",
        "3. Ketuk Tautkan Perangkat.",
        "4. Pindai kode QR ini."
      ]
    });
  } catch (err) {
    console.error('❌ Gagal menghasilkan QR:', err.message);
    res.status(500).json({ error: 'Gagal menghasilkan QR code.', message: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server berjalan di http://localhost:${port}`);
  console.log('Folder "public" sekarang disajikan secara statis.');
});
