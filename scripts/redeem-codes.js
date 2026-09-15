import {
  verifyLToken,
  findUserGameRole,
  redeemCode,
  loadAccounts,
  loadPromoCodes,
  getWibTime,
  sendTelegramMessage,
  delay,
} from './hoyolab-api.js';

async function main() {
  const now = getWibTime();
  const accounts = loadAccounts();
  const codes = loadPromoCodes();

  console.log(`[${now} WIB] Memulai proses redeem code...`);
  console.log(`Total akun terdeteksi: ${accounts.length}`);
  console.log(`Total kode promo yang akan ditukar: ${codes.length}`);

  if (codes.length === 0) {
    console.log('Tidak ada kode promo untuk di-redeem.');
    return;
  }

  const lines = [
    'Redeem Promo Code Genshin Impact',
    `Waktu: ${now} WIB`,
    `Total Akun: ${accounts.length}`,
    `Kode: ${codes.join(', ')}`,
    '',
  ];

  console.log(`\nMenjalankan proses redeem untuk ${accounts.length} akun secara paralel...`);

  // Eksekusi paralel per akun dengan staggered start 300ms agar request tidak menumpuk dalam 1 milidetik
  const accountResults = await Promise.all(
    accounts.map(async (account, accountIndex) => {
      if (accountIndex > 0) {
        await delay(accountIndex * 300);
      }

      console.log(`[Start Akun ${accountIndex + 1}/${accounts.length}] ${account.name} (${account.source})`);

      // 1. Verifikasi LToken terlebih dahulu
      const verify = await verifyLToken(account);
      if (!verify.valid) {
        const failMsg = `LToken tidak valid: ${verify.message}`;
        console.error(`- [Akun ${accountIndex + 1}] ${failMsg}`);
        return {
          accountIndex,
          lines: [`${accountIndex + 1}. ${account.name}`, `Status: GAGAL - ${failMsg}`, ''],
        };
      }

      // 2. Deteksi otomatis Region & UID Game
      const roleInfo = await findUserGameRole(account);
      if (!roleInfo.found) {
        console.error(`- [Akun ${accountIndex + 1}] ${roleInfo.message}`);
        return {
          accountIndex,
          lines: [`${accountIndex + 1}. ${account.name}`, `Status: GAGAL - ${roleInfo.message}`, ''],
        };
      }

      console.log(`- [Akun ${accountIndex + 1}] Karakter: ${roleInfo.nickname} (Lv. ${roleInfo.level}) | UID: ${roleInfo.uid} | Region: ${roleInfo.regionName}`);
      const accountLines = [
        `${accountIndex + 1}. ${account.name} - ${roleInfo.nickname} (UID: ${roleInfo.uid})`,
        `Server: ${roleInfo.regionName}`,
      ];

      // 3. Redeem setiap promo code
      for (const cdkey of codes) {
        const startTime = Date.now();
        try {
          const result = await redeemCode({
            accountOrLtoken: account,
            uid: roleInfo.uid,
            region: roleInfo.region,
            cdkey,
          });

          const statusLabel = result.success
            ? 'BERHASIL'
            : result.isAlreadyClaimed
            ? 'SUDAH DIKLAIM'
            : result.isLimitReached
            ? 'LIMIT HABIS'
            : 'GAGAL';

          console.log(`  * [Akun ${accountIndex + 1}][${cdkey}] ${statusLabel} -> ${result.message}`);
          accountLines.push(`  * ${cdkey}: ${statusLabel} (${result.message})`);
        } catch (err) {
          console.error(`  * [Akun ${accountIndex + 1}][${cdkey}] ERROR -> ${err.message}`);
          accountLines.push(`  * ${cdkey}: ERROR (${err.message})`);
        }

        // Jeda aman per akun 5.5 detik penuh antar kode untuk antisipasi cooldown HoYoverse
        await delay(5500);
      }

      accountLines.push('');
      return {
        accountIndex,
        lines: accountLines,
      };
    })
  );

  // Urutkan kembali sesuai urutan akun semula agar laporan Telegram rapi
  accountResults.sort((a, b) => a.accountIndex - b.accountIndex);
  for (const result of accountResults) {
    lines.push(...result.lines);
  }

  // Kirim notifikasi Telegram jika botToken & chatId ada di env
  const botToken = process.env.BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (botToken && chatId) {
    try {
      await sendTelegramMessage(botToken, chatId, lines.join('\n'));
      console.log('\nLaporan hasil redeem berhasil dikirim ke Telegram.');
    } catch (telegramErr) {
      console.error('\nGagal mengirim laporan ke Telegram:', telegramErr.message);
    }
  }

  console.log('\nProses redeem selesai.');
}

main().catch((error) => {
  console.error('Fatal error saat redeem codes:', error.message);
  process.exit(1);
});
