import { Client } from 'genshin-kit.js';
import { appendFileSync } from 'node:fs';

const TELEGRAM_LIMIT = 3900;
const LOG_FILE = new URL('../log.txt', import.meta.url);

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Secret ${name} belum diisi.`);
  }
  return value;
}

function getWibTime() {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function parseJson(value, secretName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Secret ${secretName} harus berupa JSON valid. ${error.message}`);
  }
}

function normalizeAccount(account, index) {
  const name = account?.name?.trim() || `Akun ${index + 1}`;
  const ltuid = String(account?.ltuid || '').trim();
  const ltoken = String(account?.ltoken || '').trim();

  if (!ltuid || !ltoken) {
    throw new Error(`Data akun ke-${index + 1} harus punya ltuid dan ltoken.`);
  }

  return { name, ltuid, ltoken };
}

function loadSplitAccountSecrets() {
  return Object.entries(process.env)
    .map(([key, value]) => {
      const match = key.match(/^GENSHIN_ACCOUNT_(\d+)$/);
      return match && value?.trim()
        ? { index: Number(match[1]), value: value.trim(), secretName: key }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map((item, index) => normalizeAccount(parseJson(item.value, item.secretName), index));
}

function loadAccounts() {
  const splitAccounts = loadSplitAccountSecrets();
  if (splitAccounts.length > 0) {
    return splitAccounts;
  }

  const rawAccounts = getRequiredEnv('GENSHIN_ACCOUNTS');
  const accounts = parseJson(rawAccounts, 'GENSHIN_ACCOUNTS');
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('Secret GENSHIN_ACCOUNTS harus berupa array dan minimal berisi 1 akun.');
  }

  return accounts.map(normalizeAccount);
}

async function checkIn(account) {
  const client = new Client();
  client.login(account.ltuid, account.ltoken);

  if (!client.dailyReward?.checkIn) {
    throw new Error('Fitur dailyReward.checkIn tidak tersedia dari genshin-kit.js.');
  }

  const result = await client.dailyReward.checkIn({});
  const status = result?.status || result?.message || result?.retmsg || JSON.stringify(result);

  let detail = status || 'Tidak ada detail.';
  try {
    const cookie = client.cookieManager.get().cookie;
    const rewardInfo = await client.dailyReward.rewardInfo.fetch({ cookie });
    if (rewardInfo) {
      detail += ` | Total login: ${rewardInfo.total_sign_day ?? '-'} | Hari ini: ${rewardInfo.today ?? '-'}`;
    }
  } catch {
    // Detail reward tidak wajib. Check-in utama tetap dianggap memakai hasil checkIn().
  }

  return detail;
}

function isFailure(message) {
  return /error|failed|fail|gagal|captcha|verify|verifikasi/i.test(String(message));
}

function getLogAccountName(account, index) {
  return account.name.includes('@') ? `Akun ${index + 1}` : account.name;
}

function splitMessage(text) {
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > TELEGRAM_LIMIT) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function appendLog(lines) {
  const logEntry = [
    '==================================================',
    ...lines,
    '',
  ].join('\n');

  appendFileSync(LOG_FILE, `${logEntry}\n`, 'utf8');
}

async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  for (const chunk of splitMessage(text)) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gagal kirim pesan Telegram: HTTP ${response.status} ${body}`);
    }
  }
}

async function main() {
  const botToken = getRequiredEnv('BOT_TOKEN');
  const chatId = getRequiredEnv('TELEGRAM_CHAT_ID');
  const accounts = loadAccounts();

  const lines = [
    'Daily Check-in Genshin',
    `Waktu: ${getWibTime()} WIB`,
    `Total akun: ${accounts.length}`,
    '',
  ];
  const logLines = [...lines];

  let successCount = 0;
  let failedCount = 0;

  for (const [index, account] of accounts.entries()) {
    try {
      const detail = await checkIn(account);
      const failed = isFailure(detail);

      if (failed) failedCount += 1;
      else successCount += 1;

      lines.push(
        `${index + 1}. ${account.name}`,
        `Status: ${failed ? 'GAGAL' : 'BERHASIL'}`,
        `Pesan: ${detail}`,
        ''
      );
      logLines.push(
        `${index + 1}. ${getLogAccountName(account, index)}`,
        `Status: ${failed ? 'GAGAL' : 'BERHASIL'}`,
        `Pesan: ${detail}`,
        ''
      );
    } catch (error) {
      failedCount += 1;
      lines.push(
        `${index + 1}. ${account.name}`,
        'Status: GAGAL',
        `Pesan: ${error.message}`,
        ''
      );
      logLines.push(
        `${index + 1}. ${getLogAccountName(account, index)}`,
        'Status: GAGAL',
        `Pesan: ${error.message}`,
        ''
      );
    }
  }

  lines.push(`Berhasil: ${successCount}`);
  lines.push(`Gagal: ${failedCount}`);
  logLines.push(`Berhasil: ${successCount}`);
  logLines.push(`Gagal: ${failedCount}`);

  appendLog(logLines);

  await sendTelegramMessage(botToken, chatId, lines.join('\n'));

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error.message);

  appendLog([
    'Daily Check-in Genshin',
    `Waktu: ${getWibTime()} WIB`,
    'Status: GAGAL',
    `Pesan: ${error.message}`,
  ]);

  const botToken = process.env.BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (botToken && chatId) {
    try {
      await sendTelegramMessage(botToken, chatId, `Daily Check-in Genshin gagal dijalankan.\nPesan: ${error.message}`);
    } catch (telegramError) {
      console.error(telegramError.message);
    }
  }

  process.exit(1);
});
