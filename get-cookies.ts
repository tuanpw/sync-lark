/**
 * Launch Chrome with remote debugging → login to Lark → press Enter → extract cookies
 *
 * Usage (PowerShell):
 *   bun run get-cookies.ts
 */

import { spawn } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const LARK_URL = process.argv[2] ?? 'https://printway.sg.larksuite.com/drive/folder/KU5Bfaa8QlVCqXdtkxvunrojsz5';
const USER_DATA_DIR = join(process.cwd(), '.chrome-profile');
const COOKIES_FILE = join(process.cwd(), 'cookies.json');
const CDP_PORT = 9222;

function findChrome(): string {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  for (const p of paths) if (existsSync(p)) return p;
  throw new Error('Chrome not found');
}

async function extractCookies(): Promise<any[]> {
  // Get page list
  const listRes = await fetch(`http://localhost:${CDP_PORT}/json`);
  const pages = await listRes.json() as any[];
  if (pages.length === 0) throw new Error('No browser pages found');

  const wsUrl = pages[0].webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('No WebSocket URL — is Chrome running with --remote-debugging-port?');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP timeout 15s')); }, 15000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result?.cookies ?? []);
      }
    };

    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket error')); };
  });
}

async function main() {
  const chromePath = findChrome();
  if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('Launching Chrome...');
  const chrome = spawn(chromePath, [
    `--user-data-dir=${USER_DATA_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    LARK_URL,
  ], { stdio: 'ignore', detached: true });
  chrome.unref();

  // Wait for Chrome to start
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`http://localhost:${CDP_PORT}/json`);
      break;
    } catch {
      await Bun.sleep(500);
    }
  }

  console.log('\nChrome opened. Login to Lark if needed.');
  console.log('When you see the folder contents, press ENTER here.\n');

  // Wait for Enter
  process.stdout.write('> Press ENTER to extract cookies... ');
  for await (const _ of console) { break; }

  console.log('Extracting cookies via CDP...');

  try {
    const allCookies = await extractCookies();
    const larkCookies = allCookies.filter((c: any) =>
      c.domain.includes('larksuite') || c.domain.includes('lark') || c.domain.includes('feishu')
    );

    writeFileSync(COOKIES_FILE, JSON.stringify(larkCookies, null, 2));
    console.log(`\nSaved ${larkCookies.length} Lark cookies to cookies.json`);
    console.log(`\nNext step:`);
    console.log(`  bun run sync-browser.ts "https://printway.sg.larksuite.com/drive/folder/KU5Bfaa8QlVCqXdtkxvunrojsz5" Mockup-v1`);
  } catch (err: any) {
    console.error('Failed:', err.message);
    console.error('Make sure Chrome is still open and you are logged in.');
  }
}

main().catch(console.error);
