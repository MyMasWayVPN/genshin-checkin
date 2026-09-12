# Genshin Daily Check-in & Auto-Redeem

Automasi harian Genshin Impact menggunakan GitHub Actions dengan rotasi User-Agent, auto-redeem kode promo multi-akun paralel, serta auto-clean untuk token kedaluwarsa.

---

## Fitur Utama

1. **Daily Check-in** (`scripts/daily-checkin.js`)
   - Berjalan otomatis setiap hari pukul **00:00 WIB** (`17:00 UTC`).
   - Rotasi User-Agent modern pada setiap request API.
   - Deteksi akun mati/expired otomatis (lapor ke Telegram + pembersihan secret).

2. **Monitor Kode Promo & Auto-Redeem** (`scripts/promo-codes.js`)
   - Memantau wiki Fandom setiap **5 jam** (`0 */5 * * *`).
   - Setiap ada kode baru: **langsung auto-redeem** ke semua akun terdaftar secara paralel (hanya butuh ~50 detik untuk puluhan akun).
   - Cooldown aman 5.5 detik per akun dengan auto-retry.

3. **Manual Redeem Codes** (`scripts/redeem-codes.js`)
   - Jalankan klaim kode redeem tertentu atau semua kode aktif kapan saja lewat menu **Actions** (`workflow_dispatch`).

---

## Konfigurasi GitHub Secrets

Buka repositori di GitHub: **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**.

| Secret Name | Wajib | Keterangan |
| :--- | :---: | :--- |
| `BOT_TOKEN` | Ya | Token bot dari [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Ya | ID chat/grup tujuan notifikasi |
| `GENSHIN_ACCOUNT_1` s/d `50` | Opsional* | Format 1 akun per secret (disarankan) |
| `GENSHIN_ACCOUNTS` | Opsional* | Format array (bisa memuat puluhan/ratusan akun tanpa batas) |
| `GH_PAT` | Opsional | GitHub Personal Access Token (scope `repo`) untuk fitur auto-update/delete secret akun mati |

*\*Wajib mengisi minimal salah satu antara `GENSHIN_ACCOUNT_1` atau `GENSHIN_ACCOUNTS`.*

### Format Data Akun

**Opsi 1: 1 Secret per Akun (Disarankan)**
Nama secret: `GENSHIN_ACCOUNT_1`, `GENSHIN_ACCOUNT_2`, dst.
```json
{
  "name": "Akun Utama",
  "ltuid": "123456789",
  "ltoken": "v2_xxxxxxxxx"
}
```

**Opsi 2: Array Akun dalam 1 Secret**
Nama secret: `GENSHIN_ACCOUNTS`
```json
[
  {
    "name": "Akun Utama",
    "ltuid": "123456789",
    "ltoken": "v2_xxxxxxxxx"
  },
  {
    "name": "Akun 2",
    "ltuid": "98765432",
    "ltoken": "v2_xxxxxxxxx"
  }
]
```

### Override LToken Cepat
Jika `ltoken` kedaluwarsa tanpa ingin mengedit JSON:
- Untuk `GENSHIN_ACCOUNT_3`: Buat secret `GENSHIN_ACCOUNT_3_LTOKEN` = `v2_token_baru`
- Untuk array ke-2 di `GENSHIN_ACCOUNTS`: Buat secret `GENSHIN_ACCOUNTS_2_LTOKEN` = `v2_token_baru`

---

## Fitur Auto-Delete / Auto-Update Akun Mati

Saat daily check-in mendeteksi token akun sudah expired atau karakter tidak ditemukan:
- **Akun Satuan (`GENSHIN_ACCOUNT_X`)**: Secret langsung dihapus otomatis dari GitHub jika `GH_PAT` dipasang.
- **Akun Array (`GENSHIN_ACCOUNTS`)**: Hanya akun mati yang dibuang; sisa akun aktif akan disimpan kembali ke secret secara otomatis.
- **Notifikasi Telegram**: Jika `GH_PAT` tidak diset, bot mengirimkan teks JSON array yang sudah bersih langsung ke chat Telegram agar bisa langsung disalin-tempel manual.

> **Cara Buat GH_PAT (Opsional):**
> Masuk ke GitHub Profile -> **Settings** -> **Developer Settings** -> **Personal Access Tokens (Tokens classic)** -> **Generate new token**. Centang izin **`repo`**, simpan, dan masukkan tokennya ke Secret `GH_PAT`.

---

## Pengujian Lokal

```bash
# Install dependencies
npm ci

# Jalankan Check-in
npm run daily-checkin

# Pantau Kode Promo & Auto-Redeem
npm run promo-codes

# Jalankan Redeem Kode Tertentu Secara Manual
node scripts/redeem-codes.js GENSHIN2026 PRIMODONNA
```

---

## Log & Output

- `log.txt`: Menyimpan riwayat hasil daily check-in terakhir.
- `promo-codes.json`: Menyimpan database daftar kode promo Genshin yang aktif.
- Kedua file diperbarui dan di-commit otomatis oleh GitHub Actions.
