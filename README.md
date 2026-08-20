# Genshin Daily Check-in

Script ini menjalankan dua workflow lewat GitHub Actions:

1. **Daily Check-in** (`scripts/daily-checkin.js`) — check-in akun Genshin setiap hari jam `00:00 WIB`, mengirim hasilnya ke Telegram Bot, dan menyimpan hasil terbaru ke `log.txt`.
2. **Monitor Kode Promo** (`scripts/promo-codes.js`) — memantau halaman Promotional Code Genshin setiap 3 jam, mengirim kode promo baru ke Telegram Bot, dan menyimpan daftar kode ke `promo-codes.json`.

## 1. Buat Telegram Bot

1. Buka Telegram dan chat `@BotFather`.
2. Buat bot baru dengan command:

```txt
/newbot
```

3. Simpan token bot yang diberikan BotFather. Token ini nanti dipakai untuk secret `BOT_TOKEN`.
4. Kirim pesan apa saja ke bot kamu agar bot bisa mengirim pesan balik ke akun/grup tujuan.

## 2. Ambil Telegram Chat ID

Untuk akun pribadi:

1. Chat bot `@userinfobot` di Telegram.
2. Ambil angka ID Telegram kamu.
3. ID itu dipakai untuk secret `TELEGRAM_CHAT_ID`.

Untuk grup:

1. Masukkan bot kamu ke grup.
2. Jadikan bot sebagai member yang bisa mengirim pesan.
3. Ambil chat ID grup memakai bot seperti `@RawDataBot`, lalu gunakan ID grup tersebut sebagai `TELEGRAM_CHAT_ID`.

## 3. Siapkan Data Akun Genshin

Cara yang disarankan adalah **1 secret untuk 1 akun**. Dengan cara ini kamu bisa menambah akun baru tanpa mengedit secret akun lama.

Secret akun pertama:

```txt
GENSHIN_ACCOUNT_1
```

Value:

```json
{
  "name": "Akun Utama",
  "ltuid": "123456789",
  "ltoken": "v2_xxxxxxxxx"
}
```

Secret akun kedua:

```txt
GENSHIN_ACCOUNT_2
```

Value:

```json
{
  "name": "Akun 2",
  "ltuid": "98765432",
  "ltoken": "v2_xxxxxxxxx"
}
```

Untuk menambah akun baru, buat secret baru berikutnya:

```txt
GENSHIN_ACCOUNT_3
GENSHIN_ACCOUNT_4
GENSHIN_ACCOUNT_5
```

Workflow sudah menyiapkan slot sampai:

```txt
GENSHIN_ACCOUNT_20
```

Alternatif lama tetap didukung, yaitu memakai satu secret `GENSHIN_ACCOUNTS` dengan format array:

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

Pastikan JSON valid:

- Gunakan tanda kutip ganda.
- Jangan ada koma setelah item terakhir.
- `ltuid` dan `ltoken` wajib diisi.

Jika `GENSHIN_ACCOUNTS` dan `GENSHIN_ACCOUNT_1`, `GENSHIN_ACCOUNT_2`, dan seterusnya sama-sama diisi, semua akun dari kedua format tersebut akan dijalankan.

## 4. Monitor Kode Promo

Workflow **Promo Codes Monitor** (`scripts/promo-codes.js`) berjalan otomatis **setiap 3 jam**:

```txt
Setiap 3 jam
```

Di file GitHub Actions, jadwal ini ditulis sebagai:

```yml
cron: '0 */3 * * *'
```

Karena GitHub Actions memakai UTC, jadwal tersebut sama dengan setiap 3 jam sekali, dimulai `07:00 WIB`.

Cara kerjanya:

1. Scrape daftar kode promo dari halaman Promotional Code Genshin Impact.
2. Bandingkan dengan daftar kode lama di `promo-codes.json`.
3. Jika ada kode baru yang masih aktif, kirim notifikasi ke Telegram Bot.
4. Simpan daftar kode terbaru ke `promo-codes.json` (di-commit otomatis oleh workflow).

Workflow ini hanya butuh secret `BOT_TOKEN` dan `TELEGRAM_CHAT_ID` (sama seperti daily check-in). Tidak butuh secret akun Genshin.

Test lokal di PowerShell:

```powershell
$env:BOT_TOKEN="isi_token_bot"
$env:TELEGRAM_CHAT_ID="isi_id_telegram"

npm ci
npm run promo-codes
```


## 5. Isi GitHub Actions Secrets

Di repository GitHub:

1. Buka `Settings`.
2. Pilih `Secrets and variables`.
3. Pilih `Actions`.
4. Klik `New repository secret`.
5. Tambahkan secret berikut:

```txt
BOT_TOKEN
TELEGRAM_CHAT_ID
GENSHIN_ACCOUNT_1
```

Jika punya akun kedua, tambahkan:

```txt
GENSHIN_ACCOUNT_2
```

Lanjutkan berurutan untuk akun berikutnya. Kamu tidak perlu mengedit secret akun lama.

## 6. Jalankan Manual Untuk Test

Tidak perlu menunggu jam `00:00 WIB`.

1. Buka tab `Actions` di GitHub repository.
2. Pilih workflow `Daily Genshin Check-in` atau `Promo Codes Monitor`.
3. Klik `Run workflow`.
4. Pilih branch.
5. Klik `Run workflow`.

Jika berhasil, bot Telegram akan mengirim hasil check-in dan `log.txt` akan diperbarui otomatis.

## 7. Jadwal Otomatis

Workflow daily check-in berjalan otomatis setiap hari:

```txt
00:00 WIB
```

Di file GitHub Actions, jadwal ini ditulis sebagai:

```yml
cron: '0 17 * * *'
```

Karena GitHub Actions memakai UTC, `17:00 UTC` sama dengan `00:00 WIB`.

## 8. Test Lokal Di Windows

### Command Prompt

```bat
set "BOT_TOKEN=isi_token_bot"
set "TELEGRAM_CHAT_ID=isi_id_telegram"
set GENSHIN_ACCOUNT_1={"name":"Akun Utama","ltuid":"123456789","ltoken":"v2_xxxxxxxxx"}
set GENSHIN_ACCOUNT_2={"name":"Akun 2","ltuid":"98765432","ltoken":"v2_xxxxxxxxx"}

npm ci
npm run daily-checkin
```

### PowerShell

```powershell
$env:BOT_TOKEN="isi_token_bot"
$env:TELEGRAM_CHAT_ID="isi_id_telegram"
$env:GENSHIN_ACCOUNT_1='{"name":"Akun Utama","ltuid":"123456789","ltoken":"v2_xxxxxxxxx"}'
$env:GENSHIN_ACCOUNT_2='{"name":"Akun 2","ltuid":"98765432","ltoken":"v2_xxxxxxxxx"}'

npm ci
npm run daily-checkin
```

## 9. Log

Setiap script berjalan, hasil terbaru akan disimpan ke:

```txt
log.txt           -> hasil daily check-in
promo-codes.json  -> daftar kode promo terbaru
```

GitHub Actions akan melakukan commit otomatis jika `log.txt` atau `promo-codes.json` berubah. Isi `log.txt` akan diperbarui dengan hasil run terbaru, bukan ditumpuk dengan riwayat lama.

Jika repository memakai branch protection dan GitHub Actions tidak boleh push commit, step commit log bisa gagal. Solusinya izinkan GitHub Actions menulis ke repository atau nonaktifkan branch protection untuk branch tersebut.

## 10. Catatan Keamanan

- Jangan simpan `BOT_TOKEN`, `ltuid`, atau `ltoken` di file repository.
- Simpan semua rahasia di GitHub Actions Secrets.
- Jika token bot pernah terlanjur dipublikasikan, regenerate token lewat `@BotFather`.
- Jika `ltoken` expired, update secret akun terkait, misalnya `GENSHIN_ACCOUNT_2`.
