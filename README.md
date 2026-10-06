# ZM Market Community

Web komunitas tema pink dengan login, status, grup, chat real-time, dan panel admin.

## Jalankan
Node.js 22+ diperlukan.

```bash
npm install
npm start
```

Buka http://localhost:3000

## Admin
Username: `admin`
Password: `112122`

Untuk penggunaan publik/produksi, ganti password admin, SESSION_SECRET, aktifkan HTTPS, rate limiting, dan gunakan deployment/database yang sesuai.


## Penting jika muncul "Unexpected token ... is not valid JSON"
Jangan jalankan hanya dengan membuka `index.html` menggunakan Live Server. Backend Node harus aktif.

Di folder proyek jalankan:
`npm install` lalu `npm start`

Versi ini juga sudah bisa mendeteksi Live Server dan mencoba terhubung ke backend `http://localhost:3000`. Namun backend tetap harus aktif.
