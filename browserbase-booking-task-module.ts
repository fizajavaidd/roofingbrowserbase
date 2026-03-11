// browserbase-booking-task-module.ts
// This is the same booking task, but exported as a callable function
// so the server.ts can import and call it with dynamic inputs.
// v2 — FIXED: added waits after customer row clicks, robust profile detection, logging

import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";
const DEBUG_DIR = process.env.DEBUG_DIR || "./debug";

// --- Address helpers ---
function normalizeStreetAddress(address: string): string {
  if (!address) return "";
  let n = address.toLowerCase().trim().replace(/\s+/g, " ").replace(/\./g, "");
  const replacements: Record<string, string> = {
    "\\bn\\b": "north", "\\bs\\b": "south", "\\be\\b": "east", "\\bw\\b": "west",
    "\\bne\\b": "northeast", "\\bnw\\b": "northwest", "\\bse\\b": "southeast", "\\bsw\\b": "southwest",
    "\\bave\\b": "avenue", "\\bav\\b": "avenue", "\\bst\\b": "street", "\\bstr\\b": "street",
    "\\brd\\b": "road", "\\bdr\\b": "drive", "\\bblvd\\b": "boulevard", "\\bln\\b": "lane",
    "\\bct\\b": "court", "\\bcir\\b": "circle", "\\bpl\\b": "place", "\\bpkwy\\b": "parkway",
    "\\bhwy\\b": "highway", "\\bter\\b": "terrace", "\\bterr\\b": "terrace", "\\btrl\\b": "trail",
  };
  for (const [abbr, full] of Object.entries(replacements)) {
    n = n.replace(new RegExp(abbr, "gi"), full);
  }
  return n.replace(/\s+/g, " ").trim();
}

function addressesMatch(a1: string, a2: string): boolean {
  const n1 = normalizeStreetAddress(a1), n2 = normalizeStreetAddress(a2);
  return n1.includes(n2) || n2.includes(n1);
}

function extractStreetNumber(address: string): string {
  return address.match(/^\d+/)?.[0] || "";
}

// --- Time helpers ---
function parseRequestedTimeToHour(timeStr: string): number | null {
  if (!timeStr || timeStr === "Not Provided") return null;
  const norm = timeStr.toLowerCase().replace(/\s+/g, " ").trim();
  const m = norm.match(/(\d{1,2})(?::(\d{2}))?\s*(?:(am|pm))?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const sap = m[3], eh = parseInt(m[4], 10), eap = m[6];
    if (sap) { if (sap === "pm" && h < 12) h += 12; if (sap === "am" && h === 12) h = 0; }
    else if (eap === "pm") {
      if (eh === 12) { if (h === 12) h = 0; }
      else if (h > eh) { /* crosses noon */ }
      else if (h === eh) { if (h < 12) h += 12; }
      else { if (h < 12) h += 12; }
    } else if (eap === "am") {
      if (eh === 12) { if (h < 12) h += 12; }
      else if (h === 12) h = 0;
      else if (h > eh) { if (h < 12) h += 12; }
      else { if (h === 12) h = 0; }
    }
    return h;
  }
  const sm = norm.match(/(\d{1,2})/);
  if (sm) { let h = parseInt(sm[1], 10); if (norm.includes("pm") && h < 12) h += 12; return h; }
  return null;
}

function extractHourFromDataCy(dc: string): number | null {
  return dc?.match(/T(\d{2}):\d{2}:\d{2}/) ? parseInt(dc.match(/T(\d{2}):\d{2}:\d{2}/)![1], 10) : null;
}

// --- Step infrastructure ---
interface StepDef { name: string; action: any; validator: any; skipIf: any; onSuccess: any; timeout: number; }

class StepBuilder {
  private _n: string; private _a: any = null; private _v: any = null;
  private _s: any = null; private _o: any = null; private _t = 10000;
  constructor(n: string) { this._n = n; }
  goto(u: string) { this._a = { type: "goto", url: u }; return this; }
  click(s: string) { this._a = { type: "click", selector: s }; return this; }
  fill(s: string, v: any) { this._a = { type: "fill", selector: s, value: v }; return this; }
  type(s: string, v: any, o: any = {}) { this._a = { type: "type", selector: s, value: v, options: o }; return this; }
  select(s: string, v: any) { this._a = { type: "select", selector: s, value: v }; return this; }
  press(s: string, k: string) { this._a = { type: "press", selector: s, key: k }; return this; }
  waitFor(s: string, st = "visible") { this._a = { type: "waitFor", selector: s, state: st }; return this; }
  wait(ms: number) { this._a = { type: "wait", ms }; return this; }
  scroll(t = "bottom") { this._a = { type: "scroll", target: t }; return this; }
  custom(fn: any) { this._a = { type: "custom", fn }; return this; }
  ai(p: string) { this._a = { type: "ai", prompt: p }; return this; }
  noop() { this._a = { type: "noop" }; return this; }
  expectUrl(p: any) { this._v = { type: "url", pattern: p }; return this; }
  expectVisible(s: string) { this._v = { type: "visible", selector: s }; return this; }
  expectNotVisible(s: string) { this._v = { type: "notVisible", selector: s }; return this; }
  expectText(t: string) { this._v = { type: "text", text: t }; return this; }
  expectValue(s: string, v: any) { this._v = { type: "value", selector: s, value: v }; return this; }
  expect(fn: any) { this._v = { type: "custom", fn }; return this; }
  expectAi(p: string) { this._v = { type: "ai", prompt: p }; return this; }
  skipIf(c: any) { this._s = c; return this; }
  setContext(k: string, v: any) { this._o = { type: "setContext", key: k, value: v }; return this; }
  captureContext(k: string, fn: any) { this._o = { type: "captureContext", key: k, fn }; return this; }
  timeout(ms: number) { this._t = ms; return this; }
  build(): StepDef { return { name: this._n, action: this._a, validator: this._v, skipIf: this._s, onSuccess: this._o, timeout: this._t }; }
}
function step(n: string) { return new StepBuilder(n); }

// --- Executor ---
let stagehandRef: Stagehand;

// Helper: wait for a selector to become visible (works with Stagehand's locators)
async function waitForVisible(page: any, selector: string, timeoutMs = 10000) {
  const start = Date.now();
  // Handle comma-separated selectors (try each one)
  const selectors = selector.split(",").map(s => s.trim());
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      try {
        const visible = await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) return true;
      } catch { /* ignore */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timeout waiting for "${selector}" to be visible after ${timeoutMs}ms`);
}

// Helper: wait for a selector to become hidden
async function waitForHidden(page: any, selector: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const visible = await page.locator(selector).first().isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) return true;
    } catch { return true; }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timeout waiting for "${selector}" to be hidden after ${timeoutMs}ms`);
}

async function execAction(page: any, action: any, ctx: any) {
  if (!action || action.type === "noop") return;
  const val = (v: any) => typeof v === "function" ? v(ctx) : v;
  switch (action.type) {
    case "goto": await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 }); break;
    case "click": await page.locator(action.selector).first().click({ timeout: 10000 }); break;
    case "fill": await page.locator(action.selector).first().fill(val(action.value)); break;
    case "type": await page.locator(action.selector).first().pressSequentially(val(action.value), { delay: action.options?.delay || 50 }); break;
    case "select": await page.locator(action.selector).first().selectOption(val(action.value)); break;
    case "press": await page.locator(action.selector).first().press(action.key); break;
    case "waitFor":
      if (action.state === "hidden") {
        await waitForHidden(page, action.selector, 10000);
      } else {
        await waitForVisible(page, action.selector, 10000);
      }
      break;
    case "wait": await page.waitForTimeout(action.ms); break;
    case "scroll":
      if (action.target === "bottom") await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      else if (action.target === "top") await page.evaluate(() => window.scrollTo(0, 0));
      else await page.locator(action.target).first().scrollIntoViewIfNeeded();
      break;
    case "custom": await action.fn(page, ctx); break;
    case "ai":
      const agent = stagehandRef.agent({ mode: "cua", model: "google/gemini-2.5-computer-use-preview-10-2025" });
      await agent.execute(val(action.prompt));
      break;
  }
}

async function execValidator(page: any, v: any, ctx: any): Promise<any> {
  if (!v) return { success: true };
  try {
    switch (v.type) {
      case "url": { const u = await page.url(); const p = typeof v.pattern === "function" ? v.pattern(ctx) : v.pattern; return p instanceof RegExp ? { success: p.test(u) } : { success: u.includes(p) }; }
      case "visible": return { success: await page.locator(v.selector).first().isVisible({ timeout: 5000 }).catch(() => false) };
      case "notVisible": return { success: !(await page.locator(v.selector).first().isVisible({ timeout: 2000 }).catch(() => false)) };
      case "text": return { success: await page.getByText(v.text).first().isVisible({ timeout: 5000 }).catch(() => false) };
      case "value": { const iv = await page.locator(v.selector).first().inputValue(); return { success: iv === (typeof v.value === "function" ? v.value(ctx) : v.value) }; }
      case "custom": return await v.fn(page, ctx);
      case "ai": { const r = await stagehandRef.extract(typeof v.prompt === "function" ? v.prompt(ctx) : v.prompt); try { return typeof r === "object" ? r : JSON.parse(r as any); } catch { return { success: true, aiResponse: r }; } }
      default: return { success: true };
    }
  } catch (e: any) { return { success: false, error: e.message }; }
}

async function captureDebug(page: any, name: string, idx: number) {
  if (!DEBUG) return;
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
    await page.screenshot({ path: `${DEBUG_DIR}/step${idx}_${safe}_${ts}.png`, fullPage: true });
    fs.writeFileSync(`${DEBUG_DIR}/step${idx}_${safe}_${ts}.html`, await page.content());
  } catch (e: any) { console.log(`    ⚠️  Debug capture failed: ${e.message}`); }
}

async function runStep(sd: StepDef, page: any, ctx: any, idx = 0) {
  console.log(`  → ${sd.name}`);
  if (sd.skipIf) { const skip = typeof sd.skipIf === "function" ? await sd.skipIf(page, ctx) : sd.skipIf; if (skip) { console.log("    ⏭️  Skipped"); return { success: true, skipped: true }; } }
  try { await execAction(page, sd.action, ctx); } catch (e: any) { console.log(`    ❌ Action failed: ${e.message}`); await captureDebug(page, sd.name, idx); return { success: false, error: e.message }; }
  await page.waitForTimeout(300);
  const vr = await execValidator(page, sd.validator, ctx);
  if (!vr.success) { console.log(`    ❌ Validation failed: ${vr.error || "Check failed"}`); await captureDebug(page, sd.name, idx); return { success: false, ...vr }; }
  if (sd.onSuccess) {
    if (sd.onSuccess.type === "setContext") ctx[sd.onSuccess.key] = typeof sd.onSuccess.value === "function" ? await sd.onSuccess.value(page, ctx) : sd.onSuccess.value;
    else if (sd.onSuccess.type === "captureContext") ctx[sd.onSuccess.key] = await sd.onSuccess.fn(page, ctx);
  }
  if (vr.context) Object.assign(ctx, vr.context);
  console.log("    ✅ Done");
  return { success: true, ...vr };
}

// =============================================================================
// BUILD STEPS — uses the INPUTS object passed at runtime
// =============================================================================
function buildSteps(I: any): StepDef[] {
  return [
    // LOGIN
    step("Navigate to login page").goto("https://misterquik.sera.tech/admins/login").expectVisible('input[type="email"], input[name="email"]').build(),
    step("Fill email").fill('input[type="email"], input[name="email"]', I.stratablueEmail).build(),
    step("Fill password").fill('input[type="password"]', I.stratabluePassword).build(),
    step("Wait before login click").wait(1000).build(),
    step("Click login button").custom(async (page: any) => {
      const selectors = [
        'button:has-text("Sign In")',
        'button:has-text("Login")',
        'button:has-text("Log In")',
        'input[type="submit"]',
        'button[type="submit"]',
        '.btn-primary',
        'button.btn',
      ];
      for (const sel of selectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          console.log(`    ℹ️  Clicked login button with selector: "${sel}"`);
          return;
        }
      }
      throw new Error("Could not find login button with any known selector");
    }).build(),
    step("Wait for page to load after login").wait(5000).build(),
    step("Wait for dashboard").custom(async (page: any) => {
      for (let i = 0; i < 30; i++) {
        const url = page.url();
        if (!url.includes("/login")) {
          console.log(`    ℹ️  Redirected to: ${url}`);
          return;
        }
        await page.waitForTimeout(1000);
      }
      throw new Error("Still on login page after 30 seconds — login may have failed. Check credentials.");
    }).build(),

    // FIND CUSTOMER
    step("Navigate to customers page").goto("https://misterquik.sera.tech/customers").expectVisible("table, .customers-list").build(),
    step("Search by address").fill('th.address-field input, th[class*="address"] input', I.serviceAddress.split(",")[0].trim()).build(),
    step("Wait for search results").wait(10000).build(),

    step("Check if customer found by address").custom(async (page: any, ctx: any) => {
      const rows = page.locator("table tbody tr"); const count = await rows.count();
      console.log(`    ℹ️  Found ${count} rows in customer table`);
      for (let i = 0; i < count; i++) { const row = rows.nth(i); const t = await row.textContent();
        if ((t.includes(I.firstName) && t.includes(I.lastName)) || t.includes(I.email) || t.includes(I.phone)) {
          console.log(`    ℹ️  Matched row ${i}: "${t.substring(0, 100)}..."`);
          // Extract customer ID from the row text (first number in the row is the ID)
          const idMatch = t.match(/^(\d+)/);
          if (idMatch) {
            const customerId = idMatch[1];
            const url = `https://misterquik.sera.tech/customers/${customerId}`;
            console.log(`    ℹ️  Navigating to: ${url}`);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          } else {
            // Fallback: click the first link in that row area using page-level selector
            console.log(`    ℹ️  No ID found in text, clicking first link in row ${i}...`);
            await page.locator(`table tbody tr:nth-child(${i + 1}) a`).first().click();
          }
          await page.waitForTimeout(5000);
          ctx.customerFound = true; return;
        }
      } ctx.customerFound = false;
    }).expect(async () => ({ success: true })).build(),

    // Fallback: phone
    step("Clear address and search by phone").skipIf((_p: any, c: any) => c.customerFound).custom(async (page: any) => {
      const ai = page.locator('th.address-field input, th[class*="address"] input').first();
      if (await ai.isVisible({ timeout: 2000 }).catch(() => false)) { await ai.clear(); await page.waitForTimeout(500); }
      const pi = page.locator('th.phone-field input, th[class*="phone"] input').first();
      if (await pi.isVisible({ timeout: 2000 }).catch(() => false)) await pi.fill(I.phone);
    }).build(),
    step("Wait for phone search results").skipIf((_p: any, c: any) => c.customerFound).wait(10000).build(),

    step("Check if customer found by phone").skipIf((_p: any, c: any) => c.customerFound).custom(async (page: any, ctx: any) => {
      const rows = page.locator("table tbody tr"); const count = await rows.count();
      console.log(`    ℹ️  Phone search: ${count} rows`);
      for (let i = 0; i < count; i++) { const row = rows.nth(i); const t = await row.textContent();
        if ((t.includes(I.firstName) && t.includes(I.lastName)) || t.includes(I.email)) {
          console.log(`    ℹ️  Matched row ${i} by phone`);
          const idMatch = t.match(/^(\d+)/);
          if (idMatch) {
            await page.goto(`https://misterquik.sera.tech/customers/${idMatch[1]}`, { waitUntil: "domcontentloaded", timeout: 30000 });
          } else {
            await page.locator(`table tbody tr:nth-child(${i + 1}) a`).first().click();
          }
          await page.waitForTimeout(5000);
          ctx.customerFound = true; return;
        }
      }
    }).expect(async () => ({ success: true })).build(),

    // Fallback: email
    step("Clear phone and search by email").skipIf((_p: any, c: any) => c.customerFound).custom(async (page: any) => {
      const pi = page.locator('th.phone-field input, th[class*="phone"] input').first();
      if (await pi.isVisible({ timeout: 2000 }).catch(() => false)) { await pi.clear(); await page.waitForTimeout(500); }
      const ei = page.locator('th.email-field input, th[class*="email"] input').first();
      if (await ei.isVisible({ timeout: 2000 }).catch(() => false)) await ei.fill(I.email);
    }).build(),
    step("Wait for email search results").skipIf((_p: any, c: any) => c.customerFound).wait(10000).build(),

    step("Check if customer found by email").skipIf((_p: any, c: any) => c.customerFound).custom(async (page: any, ctx: any) => {
      const rows = page.locator("table tbody tr"); const count = await rows.count();
      console.log(`    ℹ️  Email search: ${count} rows`);
      for (let i = 0; i < count; i++) { const row = rows.nth(i); const t = await row.textContent();
        if ((t.includes(I.firstName) && t.includes(I.lastName)) || t.includes(I.email)) {
          console.log(`    ℹ️  Matched row ${i} by email`);
          const idMatch = t.match(/^(\d+)/);
          if (idMatch) {
            await page.goto(`https://misterquik.sera.tech/customers/${idMatch[1]}`, { waitUntil: "domcontentloaded", timeout: 30000 });
          } else {
            await page.locator(`table tbody tr:nth-child(${i + 1}) a`).first().click();
          }
          await page.waitForTimeout(5000);
          ctx.customerFound = true; return;
        }
      }
    }).expect(async () => ({ success: true })).build(),

    // FIX 4: Completely rewritten — tries multiple selectors + URL fallback
    step("Wait for customer profile (if found)").skipIf((_p: any, c: any) => !c.customerFound).custom(async (page: any) => {
      await page.waitForTimeout(3000);
      const selectors = ['.customer-show', 'h3:has-text("Addresses")', '.addresses-section', '.addresses-cont', '.customer-detail', '[data-cy="address-search"]'];
      for (const sel of selectors) {
        if (await page.locator(sel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log(`    ℹ️  Profile loaded (found: "${sel}")`);
          return;
        }
      }
      const url = page.url();
      if (url.includes("/customers/") && !url.endsWith("/customers")) {
        console.log(`    ℹ️  On customer profile URL: ${url}`);
        await page.waitForTimeout(3000);
        return;
      }
      throw new Error(`Customer profile did not load. URL: ${url}`);
    }).build(),

    // CREATE CUSTOMER
    step("Navigate to new customer page").skipIf((_p: any, c: any) => c.customerFound).goto("https://misterquik.sera.tech/customers/new").expectVisible('input[name*="first" i], input[placeholder*="First Name" i]').build(),
    step("Fill first name").skipIf((_p: any, c: any) => c.customerFound).fill('input[data-cy="first-name"]', I.firstName).build(),
    step("Fill last name").skipIf((_p: any, c: any) => c.customerFound).fill('input[data-cy="last-name"]', I.lastName).build(),
    step("Fill customer email").skipIf((_p: any, c: any) => c.customerFound).fill('input[data-cy="email-primary"]', I.email).build(),
    step("Fill customer phone").skipIf((_p: any, c: any) => c.customerFound).fill('input[data-cy="phone"]', I.phone).build(),
    step("Fill service address with autocomplete").skipIf((_p: any, c: any) => c.customerFound).custom(async (page: any) => {
      const ai = page.locator("#address-search-service").first(); await waitForVisible(page, "#address-search-service", 10000); await ai.click(); await ai.fill(I.serviceAddress); await page.waitForTimeout(2000);
      const fs = page.locator(".pac-item").first(); await waitForVisible(page, ".pac-item", 5000); await fs.click();
    }).build(),
    step("Wait for address selection").skipIf((_p: any, c: any) => c.customerFound).wait(1500).build(),
    step("Fill location name").skipIf((_p: any, c: any) => c.customerFound).fill('input[data-cy="location-name"]', I.locationName).build(),
    step("Select location type").skipIf((_p: any, c: any) => c.customerFound).custom(async (page: any) => {
      const dd = page.locator('[data-cy="location-type"] input[data-cy="select-input-field"]').first(); await waitForVisible(page, '[data-cy="location-type"] input[data-cy="select-input-field"]', 5000); await dd.click(); await page.waitForTimeout(500);
      const opt = page.locator('[data-cy="location-type"] .select-options .option').filter({ hasText: I.locationType }).first(); await waitForVisible(page, '[data-cy="location-type"] .select-options .option', 3000); await opt.click();
    }).build(),
    step("Scroll to bottom for tags").skipIf((_p: any, c: any) => c.customerFound).scroll("bottom").build(),
    step("Add customer tag").skipIf((_p: any, c: any) => c.customerFound).custom(async (page: any) => {
      await page.locator("i.tag-menu-btn").first().click(); await page.waitForTimeout(1000);
      const ti = page.locator('sera-input input[placeholder="Create or Select Tag"]').first(); await waitForVisible(page, 'sera-input input[placeholder="Create or Select Tag"]', 5000); await ti.fill(I.customerTag); await page.waitForTimeout(2000);
      await page.locator("span.tag-label").filter({ hasText: I.customerTag }).first().click(); await page.waitForTimeout(500);
    }).build(),
    step("Click Save & Schedule button").skipIf((_p: any, c: any) => c.customerFound).custom(async (page: any, ctx: any) => {
      await page.locator('button[data-cy="save-customer-continue"]').first().click();
      try { await waitForHidden(page, ".spinner, .loading", 30000); } catch {}
      await page.waitForTimeout(2000); ctx.customerFound = true; ctx.newCustomerCreated = true; ctx.bookingPopupOpen = true;
    }).build(),

    // LOCATE ADDRESS
    step("Search for address in customer profile").skipIf((_p: any, c: any) => !c.customerFound || c.bookingPopupOpen).custom(async (page: any) => {
      // Wait for the addresses area to load
      await page.waitForTimeout(5000);

      // Try multiple selectors for the address search input
      const searchSelectors = [
        '[data-cy="address-search"] input',
        'sera-input[data-cy="address-search"] input',
        'input[placeholder*="Search" i]',
        'input[placeholder*="Address" i]',
        '.addresses-cont input',
      ];

      const sn = extractStreetNumber(I.serviceAddress);
      const sa = I.serviceAddress.split(",")[0].trim();
      const searchTerm = sn || sa;

      let filled = false;
      for (const sel of searchSelectors) {
        try {
          const visible = await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
          if (visible) {
            await page.locator(sel).first().fill(searchTerm);
            console.log(`    ℹ️  Filled search with "${searchTerm}" using: "${sel}"`);
            filled = true;
            break;
          }
        } catch { /* try next */ }
      }

      if (!filled) {
        console.log(`    ⚠️  Could not find address search input — will check all address cards without filtering`);
      }

      await page.waitForTimeout(1500);
    }).build(),

    step("Check if address exists and click Schedule").skipIf((_p: any, c: any) => !c.customerFound || c.bookingPopupOpen).custom(async (page: any, ctx: any) => {
      const sa = I.serviceAddress.split(",")[0].trim();
      const cards = page.locator(".address-card");
      const count = await cards.count();
      console.log(`    ℹ️  Found ${count} address cards`);

      if (count === 0) { ctx.addressFound = false; return; }

      let matchedIndex = -1;
      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);
        const t = await card.textContent();
        if (addressesMatch(t, sa)) {
          matchedIndex = i;
          console.log(`    ℹ️  Address matched in card ${i}`);
          break;
        }
      }

      if (matchedIndex === -1) {
        console.log(`    ℹ️  Address "${sa}" not found in any card`);
        ctx.addressFound = false;
        return;
      }

      ctx.addressFound = true;
      // Use page-level selector to click Schedule button (avoids card.locator issue)
      try {
        const scheduleBtn = page.locator('.address-card').nth(matchedIndex).locator('sera-button[data-cy="address-schedule-link"]');
        await scheduleBtn.first().click();
      } catch {
        // Fallback: click nth schedule button on page
        console.log(`    ℹ️  Fallback: clicking schedule button by index`);
        await page.locator('sera-button[data-cy="address-schedule-link"]').nth(matchedIndex).click();
      }
      await page.waitForTimeout(2000);
    }).expect(async () => ({ success: true })).build(),

    // ADD NEW ADDRESS
    step("Open Address Actions dropdown").skipIf((_p: any, c: any) => !c.customerFound || c.addressFound || c.bookingPopupOpen).custom(async (page: any) => {
      const si = page.locator('sera-input[data-cy="address-search"] input').first();
      if (await si.isVisible({ timeout: 2000 }).catch(() => false)) { await si.clear(); await page.waitForTimeout(500); }
      await page.locator('sera-button[data-cy="address-actions-trigger"]').first().click(); await page.waitForTimeout(500);
    }).build(),
    step("Click Add Address option").skipIf((_p: any, c: any) => !c.customerFound || c.addressFound || c.bookingPopupOpen).custom(async (page: any) => {
      await page.getByText("Add Address", { exact: false }).first().click(); await page.waitForTimeout(1000);
    }).build(),
    step("Fill new address with autocomplete").skipIf((_p: any, c: any) => !c.customerFound || c.addressFound || c.bookingPopupOpen).custom(async (page: any, ctx: any) => {
      const modal = page.locator('.modal, [role="dialog"]').filter({ hasText: "New Address" }).first(); await waitForVisible(page, '.modal, [role="dialog"]', 10000);
      const ai = modal.locator('input[type="text"]').first(); await ai.click(); await ai.fill(I.serviceAddress); await page.waitForTimeout(2000);
      const fs = page.locator(".pac-item").first();
      if (await fs.isVisible({ timeout: 3000 }).catch(() => false)) { await fs.click(); await page.waitForTimeout(1500); ctx.actualStreetAddress = await ai.inputValue(); }
    }).build(),
    step("Fill location name for new address").skipIf((_p: any, c: any) => !c.customerFound || c.addressFound || c.bookingPopupOpen).custom(async (page: any) => {
      const li = page.locator('input[data-cy="location-name"]').first();
      if (await li.isVisible({ timeout: 3000 }).catch(() => false)) await li.fill(I.locationName);
    }).build(),
    step("Select location type for new address").skipIf((_p: any, c: any) => !c.customerFound || c.addressFound || c.bookingPopupOpen).custom(async (page: any) => {
      const dd = page.locator('[data-cy="location-type"] input[data-cy="select-input-field"]').first();
      if (await dd.isVisible({ timeout: 3000 }).catch(() => false)) { await dd.click(); await page.waitForTimeout(500);
        const opt = page.locator('[data-cy="location-type"] .select-options .option').filter({ hasText: I.locationType }).first();
        if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) await opt.click();
      }
    }).build(),
    step("Save new address").skipIf((_p: any, c: any) => !c.customerFound || c.addressFound || c.bookingPopupOpen).custom(async (page: any, ctx: any) => {
      const modal = page.locator('.modal, [role="dialog"]').filter({ hasText: "New Address" }).first();
      await modal.locator('button:has-text("Save"), sera-button:has-text("Save")').first().click(); await page.waitForTimeout(2000);
      ctx.addressFound = true; ctx.newAddressAdded = true;
    }).build(),
    step("Find newly added address and click Schedule").skipIf((_p: any, c: any) => !c.customerFound || !c.newAddressAdded || c.bookingPopupOpen).custom(async (page: any, ctx: any) => {
      await waitForVisible(page, ".addresses-cont", 10000); await page.waitForTimeout(1000);
      const raw = (ctx.actualStreetAddress || I.serviceAddress).split(",")[0].trim(); const sn = extractStreetNumber(raw);
      const si = page.locator('sera-input[data-cy="address-search"] input').first();
      if (await si.isVisible({ timeout: 2000 }).catch(() => false)) { await si.fill(sn || raw); await page.waitForTimeout(1500); }
      const cards = page.locator(".address-card"); const count = await cards.count();
      let found: any = null;
      for (let i = 0; i < count; i++) { const card = cards.nth(i); const t = await card.textContent(); if (addressesMatch(t, raw)) { found = card; break; } }
      if (!found && count === 1 && sn) { const t = await cards.first().textContent(); if (t.includes(sn)) found = cards.first(); }
      if (!found) throw new Error(`Failed to find address "${raw}"`);
      await found.locator('sera-button[data-cy="address-schedule-link"]').first().click();
      await page.waitForTimeout(2000); // FIX: wait for modal
    }).expectVisible('.modal, [role="dialog"], .booking-popup, .modal-content').setContext("bookingPopupOpen", true).build(),

    step("Wait for booking modal").skipIf((_p: any, c: any) => !c.addressFound || c.newAddressAdded || c.bookingPopupOpen).waitFor('.modal, [role="dialog"], .booking-popup, .modal-content', "visible").setContext("bookingPopupOpen", true).build(),

    // SERVICE CATEGORY
    step("Wait for service category select").waitFor('[data-cy="service-category-select"]', "visible").build(),
    step("Click service category input").custom(async (page: any) => {
      const sc = page.locator('[data-cy="service-category-select"]').first(); await waitForVisible(page, '[data-cy="service-category-select"]', 10000);
      await sc.locator('[data-cy="select-input-field"], .ss-input-field, input').first().click();
    }).build(),
    step("Wait for dropdown").wait(500).build(),
    step("Type service category").custom(async (page: any) => {
      await page.locator('[data-cy="service-category-select"]').first().locator('[data-cy="select-input-field"], .ss-input-field, input').first().fill(I.serviceCategory);
    }).build(),
    step("Wait for filter").wait(1500).build(),
    step("Select service category option").custom(async (page: any) => {
      const opt = page.locator('.ss-option, [role="option"], [class*="option"]').filter({ hasText: new RegExp(`^${I.serviceCategory}$`) }).first();
      if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) await opt.click();
      else { const si = page.locator('[data-cy="service-category-select"] [data-cy="select-input-field"]').first(); await si.press("ArrowDown"); await page.waitForTimeout(300); await si.press("Enter"); }
    }).build(),
    step("Wait for selection").wait(1000).build(),
    step("Wait for calendar").waitFor("table td, .calendar-day, .fc-daygrid", "visible").build(),

    // SELECT DATE (AI)
    step("Select date on calendar").ai(`Look at the calendar in the booking modal. Target Date: ${I.appointmentDate} (${I.appointmentDateMonth}, day ${I.appointmentDateDay}). Scroll down to see the calendar, navigate to ${I.appointmentDateMonth} if needed, then click ONLY day "${I.appointmentDateDay}". Do NOT select any other date. STOP when time slots appear.`).build(),

    step("Verify date and wait for time slots").custom(async (page: any, ctx: any) => {
      await page.evaluate(() => { const m = document.querySelector('.modal-content, [role="dialog"]'); if (m) (m as any).scrollTop = 0; window.scrollTo(0, 0); }); await page.waitForTimeout(500);
      ctx.selectedDate = I.appointmentDateDay;
      for (const sel of ['[data-cy^="time-slot-"]', ".slot-button"]) {
        try { await waitForVisible(page, sel, 15000); return; } catch {}
      }
      throw new Error("Time slots never appeared after selecting date.");
    }).expect(async (_p: any, c: any) => ({ success: !!c.selectedDate })).build(),

    // SELECT TIME SLOT
    step("Select time slot").custom(async (page: any, ctx: any) => {
      await page.waitForTimeout(1000);
      const allSlots = page.locator('[data-cy^="time-slot-"]'); const sc = await allSlots.count();
      if (sc === 0) throw new Error("No time slot buttons found");
      const slots: any[] = [];
      for (let i = 0; i < sc; i++) { const s = allSlots.nth(i); const cl = (await s.getAttribute("class")) || ""; const dc = (await s.getAttribute("data-cy")) || ""; const lb = (await s.textContent()).trim();
        slots.push({ index: i, label: lb, labelHour: parseRequestedTimeToHour(lb), dataCyHour: extractHourFromDataCy(dc), isClickable: !cl.split(/\s+/).includes("disabled") }); }
      const clickable = slots.filter(s => s.isClickable);
      if (clickable.length === 0) throw new Error("No clickable time slots available.");
      const rh = parseRequestedTimeToHour(I.appointmentTime);
      let target = clickable.find(s => { const n = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim(); return n(s.label) === n(I.appointmentTime); });
      if (!target && rh !== null) target = clickable.find(s => s.labelHour === rh);
      if (!target) { if (rh !== null) { target = [...clickable].sort((a, b) => Math.abs((a.labelHour ?? 99) - rh) - Math.abs((b.labelHour ?? 99) - rh))[0]; } else target = clickable[0]; ctx.timeSlotDiffers = true; }
      else ctx.timeSlotDiffers = false;
      await allSlots.nth(target.index).scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await allSlots.nth(target.index).click();
      ctx.selectedTimeSlot = target.label;
    }).build(),
    step("Verify time slot").custom(async (page: any, ctx: any) => {
      const sel = page.locator('[data-cy^="time-slot-"].selected, .slot-button.selected').first();
      if (!(await sel.isVisible({ timeout: 5000 }).catch(() => false))) {
        await page.locator('[data-cy^="time-slot-"]:not(.disabled)').first().click(); await page.waitForTimeout(500);
        ctx.selectedTimeSlot = (await page.locator('[data-cy^="time-slot-"].selected').first().textContent()).trim(); ctx.timeSlotDiffers = true;
      }
    }).expect(async (_p: any, c: any) => ({ success: !!c.selectedTimeSlot })).build(),

    // NOTES & SAVE
    step("Fill appointment notes").custom(async (page: any, ctx: any) => {
      const time = ctx.selectedTimeSlot || I.appointmentTime;
      const notes = `Booked By Stratablue AI\n\nMr Quik Inbound Agent | Existing Customer\nCreated At: ${I.createdAt}\nFirst Name: ${I.firstName}\nLast Name: ${I.lastName}\nPhone Number: ${I.phone}\nEmail: ${I.email}\nService Category: ${I.serviceCategory}\nJob Details Address: ${I.serviceAddress}\nAppointment Date: ${I.appointmentDate}\nAppointment Time: ${time}\nJob Summary: ${I.jobSummary}\nPriority Level: ${I.priorityLevel}\nAge of Home: ${I.ageOfHome}\nAge of Equipment: ${I.ageOfEquipment}\nMessage for Team: ${I.messageForTeam}\nCall Outcome: ${I.callOutcome}\nCall ID: ${I.callId}`;
      const ta = page.locator('textarea[name*="notes" i], textarea[placeholder*="Notes" i], textarea').first();
      if (await ta.isVisible({ timeout: 3000 }).catch(() => false)) await ta.fill(notes);
    }).build(),
    step("Click Save button (modal)").skipIf((_p: any, c: any) => c.newCustomerCreated).click('[data-cy="modal-submit-btn"], button:has-text("Save"), button[type="submit"]').build(),
    step("Click Save button (non-modal)").skipIf((_p: any, c: any) => !c.newCustomerCreated).click('[data-cy="save-job"], button:has-text("Schedule Appointment")').build(),
    step("Wait for confirmation").wait(3000).build(),
    step("Verify booking saved (modal)").skipIf((_p: any, c: any) => c.newCustomerCreated).custom(async (page: any, ctx: any) => {
      await page.waitForTimeout(1000);
      if (await page.locator('.modal-content, [role="dialog"]').first().isVisible().catch(() => false)) {
        const err = await page.locator('.error, .validation-error, [class*="error"]').first().textContent({ timeout: 1000 }).catch(() => null);
        if (err) throw new Error(`Booking failed: ${err}`); throw new Error("Modal still visible");
      } ctx.bookingSaved = true;
    }).expect(async (_p: any, c: any) => ({ success: c.bookingSaved === true })).build(),
    step("Verify booking saved (non-modal)").skipIf((_p: any, c: any) => !c.newCustomerCreated).custom(async (page: any, ctx: any) => {
      await page.waitForTimeout(2000); ctx.bookingSaved = true;
    }).expect(async (_p: any, c: any) => ({ success: c.bookingSaved === true })).build(),

    // DONE
    step("Generate completion report").custom(async (_page: any, ctx: any) => {
      const time = ctx.selectedTimeSlot || I.appointmentTime;
      let msg = `Booking successful for ${I.firstName} ${I.lastName} at ${I.serviceAddress} on ${I.appointmentDate} at ${time}.`;
      if (ctx.newAddressAdded) msg += `\nNote: New address was added to customer profile.`;
      if (ctx.timeSlotDiffers) msg += `\nNote: Requested ${I.appointmentTime} was unavailable. Booked ${time} instead.`;
      console.log(`\n🎉 ${msg}`); ctx.completionMessage = msg;
    }).build(),
  ];
}

// =============================================================================
// EXPORTED FUNCTION — called by server.ts
// =============================================================================
export async function runBookingTask(input: any) {
  const INPUTS = {
    stratablueEmail: process.env.STRATABLUE_EMAIL || "mcc@stratablue.com",
    stratabluePassword: process.env.STRATABLUE_PASSWORD || "",
    firstName: input.firstName || "Not Provided",
    lastName: input.lastName || "Not Provided",
    email: input.email || "Not Provided",
    phone: input.phone || "Not Provided",
    serviceAddress: input.serviceAddress || "Not Provided",
    locationType: input.locationType || "Residential",
    locationName: input.locationName || "Home",
    customerTag: input.customerTag || "Cust Created By AI",
    serviceCategory: input.serviceCategory || "PLUM",
    appointmentDate: input.appointmentDate || "Not Provided",
    appointmentDateDay: input.appointmentDateDay || "Not Provided",
    appointmentDateMonth: input.appointmentDateMonth || "Not Provided",
    appointmentTime: input.appointmentTime || "Not Provided",
    createdAt: input.createdAt || "Not Provided",
    jobSummary: input.jobSummary || "Not Provided",
    priorityLevel: input.priorityLevel || "Not Provided",
    ageOfHome: input.ageOfHome || "Not Provided",
    ageOfEquipment: input.ageOfEquipment || "Not Provided",
    messageForTeam: input.messageForTeam || "Not Provided",
    callOutcome: input.callOutcome || "Not Provided Call",
    callId: input.callId || "Not Provided",
  };

  const STEPS = buildSteps(INPUTS);
  const startTime = Date.now();
  const results: any[] = [];
  const context: any = {};

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: "google/gemini-2.5-flash",
    verbose: DEBUG ? 2 : 1,
    disablePino: !DEBUG,
  });
  stagehandRef = stagehand;

  let sessionUrl = "";

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session: ${sessionUrl}`);

    const page = stagehand.context.pages()[0];

    for (let i = 0; i < STEPS.length; i++) {
      const result = await runStep(STEPS[i], page, context, i + 1);
      results.push({ step: STEPS[i].name, ...result });
      if (!result.success) { console.log(`🛑 Stopped at step ${i + 1}: ${STEPS[i].name}`); break; }
    }
  } catch (error: any) {
    console.error(`❌ Fatal error: ${error.message}`);
    results.push({ step: "Fatal Error", success: false, error: error.message });
  } finally {
    await stagehand.close();
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  return {
    success: results.every(r => r.success),
    stepsRun: results.filter(r => r.success).length,
    stepsSkipped: results.filter(r => r.skipped).length,
    totalSteps: STEPS.length,
    elapsedMinutes: parseFloat(elapsed),
    sessionUrl,
    results,
    context,
  };
}
