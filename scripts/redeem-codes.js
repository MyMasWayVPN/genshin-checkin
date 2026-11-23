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

const getRandomDelay = (min = 3000, max = 5000) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

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

  console.log(`\nMenjalankan proses redeem untuk ${accounts.length} akun secara sekuensial (anti-rate limit)...`);

  for (const [accountIndex, account] of accounts.entries()) {
    console.log(`[Start Akun ${accountIndex + 1}/${accounts.length}] ${account.name} (${account.source})`);

    // 1. Verifikasi LToken terlebih dahulu
    let verify;
    try {
      verify = await verifyLToken(account);
    } catch (err) {
      verify = { valid: false, message: err.message };
    }

    if (!verify.valid) {
      const failMsg = `LToken tidak valid: ${verify.message}`;
      console.error(`- [Akun ${accountIndex + 1}] ${failMsg}`);
      lines.push(`${accountIndex + 1}. ${account.name}`, `Status: GAGAL - ${failMsg}`, '');
      continue;
    }

    // 2. Deteksi otomatis Region & UID Game (Semua server yang valid)
    let roleInfo;
    try {
      roleInfo = await findUserGameRole(account);
    } catch (err) {
      roleInfo = { found: false, roles: [], message: err.message };
    }

    if (!roleInfo.found || !roleInfo.roles?.length) {
      console.error(`- [Akun ${accountIndex + 1}] ${roleInfo.message}`);
      lines.push(`${accountIndex + 1}. ${account.name}`, `Status: GAGAL - ${roleInfo.message}`, '');
      continue;
    }

    const validRoles = roleInfo.roles;
    for (let rIdx = 0; rIdx < validRoles.length; rIdx += 1) {
      const currentRole = validRoles[rIdx];
      const roleLabel = validRoles.length > 1
        ? `${accountIndex + 1}.${rIdx + 1}. ${account.name} - ${currentRole.nickname} (UID: ${currentRole.uid})`
        : `${accountIndex + 1}. ${account.name} - ${currentRole.nickname} (UID: ${currentRole.uid})`;

      console.log(`- [Akun ${accountIndex + 1}] Karakter: ${currentRole.nickname} (Lv. ${currentRole.level}) | UID: ${currentRole.uid} | Region: ${currentRole.regionName}`);
      if (rIdx > 0) lines.push('');
      lines.push(roleLabel, `Server: ${currentRole.regionName}`);

      // 3. Redeem setiap promo code untuk role ini
      for (const cdkey of codes) {
        try {
          const result = await redeemCode({
            accountOrLtoken: account,
            uid: currentRole.uid,
            region: currentRole.region,
            cdkey,
          });

          const statusLabel = result.success
            ? 'BERHASIL'
            : result.isAlreadyClaimed
            ? 'SUDAH DIKLAIM'
            : result.isLimitReached
            ? 'LIMIT HABIS'
            : 'GAGAL';

          console.log(`  * [Akun ${accountIndex + 1}][${currentRole.region}][${cdkey}] ${statusLabel} -> ${result.message}`);
          lines.push(`  * ${cdkey}: ${statusLabel} (${result.message})`);
        } catch (err) {
          console.error(`  * [Akun ${accountIndex + 1}][${currentRole.region}][${cdkey}] ERROR -> ${err.message}`);
          lines.push(`  * ${cdkey}: ERROR (${err.message})`);
        }

        // Jeda aman per akun 5.5 detik penuh antar kode untuk antisipasi cooldown HoYoverse
        await delay(5500);
      }
    }

    lines.push('');

    // Jeda dinamis antar-akun (3-5 detik) agar tidak memicu rate-limit HoYoLAB
    if (accountIndex < accounts.length - 1) {
      const sleepTime = getRandomDelay(3000, 5000);
      await delay(sleepTime);
    }
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
