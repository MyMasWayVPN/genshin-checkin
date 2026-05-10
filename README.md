# Genshin Daily Check-in

Script ini menjalankan daily check-in Genshin Impact lewat GitHub Actions setiap hari jam `00:00 WIB`, lalu mengirim hasilnya ke Telegram Bot dan menyimpan riwayat ke `log.txt`.

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


## 4. Isi GitHub Actions Secrets

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

## 5. Jalankan Manual Untuk Test

Tidak perlu menunggu jam `00:00 WIB`.

1. Buka tab `Actions` di GitHub repository.
2. Pilih workflow `Daily Genshin Check-in`.
3. Klik `Run workflow`.
4. Pilih branch.
5. Klik `Run workflow`.

Jika berhasil, bot Telegram akan mengirim hasil check-in dan `log.txt` akan diperbarui otomatis.

## 6. Jadwal Otomatis

Workflow berjalan otomatis setiap hari:

```txt
00:00 WIB
```

Di file GitHub Actions, jadwal ini ditulis sebagai:

```yml
cron: '0 17 * * *'
```

Karena GitHub Actions memakai UTC, `17:00 UTC` sama dengan `00:00 WIB`.

## 7. Test Lokal Di Windows

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

## 8. Log

Setiap script berjalan, hasilnya akan ditambahkan ke:

```txt
log.txt
```

GitHub Actions akan melakukan commit otomatis jika `log.txt` berubah.

Jika repository memakai branch protection dan GitHub Actions tidak boleh push commit, step commit log bisa gagal. Solusinya izinkan GitHub Actions menulis ke repository atau nonaktifkan branch protection untuk branch tersebut.

## 9. Catatan Keamanan

- Jangan simpan `BOT_TOKEN`, `ltuid`, atau `ltoken` di file repository.
- Simpan semua rahasia di GitHub Actions Secrets.
- Jika token bot pernah terlanjur dipublikasikan, regenerate token lewat `@BotFather`.
- Jika `ltoken` expired, update secret akun terkait, misalnya `GENSHIN_ACCOUNT_2`.
