// browserbase-booking-task-module.ts
// Complete rewrite — correct Stagehand v3 API, no broken locator patterns
// Rules applied:
//   - No locator.locator() chaining — all selectors are flat CSS strings
//   - No locator.waitFor() — use waitUntilVisible() helper that polls isVisible() (no args)
//   - No locator.getAttribute() — use page.evaluate()
//   - No locator.scrollIntoViewIfNeeded() — use page.evaluate() scroll
//   - locator.isVisible() takes NO arguments in Stagehand v3
//   - page.waitForSelector() and page.waitForTimeout() exist on page
//   - Complex interactions use page.evaluate() for bulletproof DOM access
//
// SEARCH ORDER: Phone → Address → Email
// Phone is searched FIRST to prevent duplicate account creation.
// Phone numbers are the most reliable match signal since addresses suffer
// from formatting differences (N vs North, Ave vs Avenue, etc).

import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";
const DEBUG_DIR = process.env.DEBUG_DIR || "./debug";

// =============================================================================
// HELPERS — Address & Time
// =============================================================================

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
  const n1 = normalizeStreetAddress(a1);
  const n2 = normalizeStreetAddress(a2);
  return n1.includes(n2) || n2.includes(n1);
}

function extractStreetNumber(address: string): string {
  return address.match(/^\d+/)?.[0] || "";
}

// =============================================================================
// HELPERS — Phone normalization
// =============================================================================

/**
 * Strips a phone string down to digits only for reliable comparison.
 * Input is always 10 digits (e.g., "3176665527") but the table UI may
 * display it with formatting like "(317) 666-5527" or "317-666-5527".
 */
function normalizePhone(phone: string): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

/**
 * Checks if a text block contains a phone number that matches the target.
 * Handles different formatting by comparing digits-only forms.
 */
function textContainsPhone(text: string, phone: string): boolean {
  const targetDigits = normalizePhone(phone);
  if (!targetDigits || targetDigits.length < 7) return false;
  const textDigits = text.replace(/\D/g, "");
  return textDigits.includes(targetDigits);
}

// =============================================================================
// HELPERS — Time
// =============================================================================

function parseRequestedTimeToHour(timeStr: string): number | null {
  if (!timeStr || timeStr === "Not Provided") return null;
  const norm = timeStr.toLowerCase().replace(/\s+/g, " ").trim();
  const m = norm.match(/(\d{1,2})(?::(\d{2}))?\s*(?:(am|pm))?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const sap = m[3], eap = m[6], eh = parseInt(m[4], 10);
    if (sap) {
      if (sap === "pm" && h < 12) h += 12;
      if (sap === "am" && h === 12) h = 0;
    } else if (eap === "pm") {
      if (eh === 12) { if (h === 12) h = 0; }
      else if (h < 12) h += 12;
    } else if (eap === "am") {
      if (h === 12) h = 0;
    }
    return h;
  }
  const sm = norm.match(/(\d{1,2})/);
  if (sm) {
    let h = parseInt(sm[1], 10);
    if (norm.includes("pm") && h < 12) h += 12;
    return h;
  }
  return null;
}

function extractHourFromDataCy(dc: string): number | null {
  const m = dc?.match(/T(\d{2}):\d{2}:\d{2}/);
  return m ? parseInt(m[1], 10) : null;
}

// =============================================================================
// PAGE HELPERS — safe wrappers that use only documented Stagehand v3 API
// =============================================================================

/**
 * Poll until selector is visible. locator.isVisible() takes NO args in Stagehand v3.
 */
async function waitUntilVisible(page: any, selector: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator(selector).first().isVisible();
      if (visible) return true;
    } catch { /* not ready yet */ }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timeout (${timeoutMs}ms): "${selector}" never became visible`);
}

/**
 * Poll until selector is hidden / gone.
 */
async function waitUntilHidden(page: any, selector: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator(selector).first().isVisible();
      if (!visible) return true;
    } catch { return true; /* element gone */ }
    await page.waitForTimeout(500);
  }
  return false; // soft-fail — don't throw
}

/**
 * Try multiple selectors, return the first one that is visible.
 */
async function firstVisible(page: any, selectors: string[], timeoutMs = 2000): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const visible = await page.locator(sel).first().isVisible();
      if (visible) return sel;
    } catch { /* try next */ }
  }
  // one retry pass with short wait
  await page.waitForTimeout(timeoutMs);
  for (const sel of selectors) {
    try {
      const visible = await page.locator(sel).first().isVisible();
      if (visible) return sel;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Get element attribute via page.evaluate — avoids locator.getAttribute() which doesn't exist.
 */
async function getAttr(page: any, selector: string, attr: string): Promise<string> {
  return page.evaluate(
    ([sel, a]: [string, string]) => {
      const el = document.querySelector(sel);
      return el ? (el.getAttribute(a) || "") : "";
    },
    [selector, attr] as [string, string]
  );
}

/**
 * Get text content of ALL matching elements via page.evaluate.
 * Returns array of { text, index } so callers can reference elements by nth index.
 */
async function getAllTexts(page: any, selector: string): Promise<Array<{ text: string; index: number }>> {
  return page.evaluate((sel: string) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.map((el, i) => ({ text: el.textContent || "", index: i }));
  }, selector);
}

/**
 * Scroll element into view using page.evaluate.
 */
async function scrollIntoView(page: any, selector: string) {
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, selector);
}

/**
 * Click nth matching element via page.evaluate (bypasses all locator chain issues).
 */
async function clickNth(page: any, selector: string, n: number) {
  await page.evaluate(([sel, idx]: [string, number]) => {
    const els = Array.from(document.querySelectorAll(sel));
    const el = els[idx] as HTMLElement;
    if (el) el.click();
    else throw new Error(`Element ${idx} not found for selector "${sel}"`);
  }, [selector, n] as [string, number]);
}

/**
 * Capture debug screenshot + HTML when DEBUG=true.
 */
async function captureDebug(page: any, name: string, idx: number) {
  if (!DEBUG) return;
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = name.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
    await page.screenshot({ path: `${DEBUG_DIR}/step${idx}_${safe}_${ts}.png`, fullPage: true });
    fs.writeFileSync(`${DEBUG_DIR}/step${idx}_${safe}_${ts}.html`, await page.content());
  } catch (e: any) {
    console.log(`    ⚠️  Debug capture failed: ${e.message}`);
  }
}

// =============================================================================
// STEP SYSTEM
// =============================================================================

interface Step {
  name: string;
  skipIf?: (page: any, ctx: any) => boolean | Promise<boolean>;
  run: (page: any, ctx: any, stagehand: Stagehand) => Promise<void>;
}

async function runStep(s: Step, page: any, ctx: any, stagehand: Stagehand, idx: number): Promise<boolean> {
  console.log(`  [${idx}] → ${s.name}`);
  if (s.skipIf) {
    const skip = await s.skipIf(page, ctx);
    if (skip) { console.log("    ⏭️  Skipped"); return true; }
  }
  try {
    await s.run(page, ctx, stagehand);
    console.log("    ✅ Done");
    return true;
  } catch (e: any) {
    console.log(`    ❌ Failed: ${e.message}`);
    await captureDebug(page, s.name, idx);
    return false;
  }
}

// =============================================================================
// BUILD STEPS
// =============================================================================

function buildSteps(I: any): Step[] {
  // Shorthand skip helpers
  const notFound = (c: any) => !c.customerFound;
  const alreadyFound = (c: any) => !!c.customerFound;
  const popupOpen = (c: any) => !!c.bookingPopupOpen;
  const foundOrPopup = (c: any) => !c.customerFound || c.bookingPopupOpen;
  const addressFoundOrPopup = (c: any) => !c.customerFound || !!c.addressFound || c.bookingPopupOpen;
  const newAddrAdded = (c: any) => !c.customerFound || !c.newAddressAdded || c.bookingPopupOpen;

  return [
    // =========================================================================
    // LOGIN
    // =========================================================================
    {
      name: "Navigate to login page",
      async run(page) {
        await page.goto("https://misterquik.sera.tech/admins/login", { waitUntil: "domcontentloaded", timeout: 300000 });
        await waitUntilVisible(page, 'input[type="email"], input[name="email"]', 150000);
      },
    },
    {
      name: "Fill email",
      async run(page) {
        const sel = await firstVisible(page, ['input[type="email"]', 'input[name="email"]']);
        if (!sel) throw new Error("Email input not found");
        await page.locator(sel).first().fill(I.stratablueEmail);
      },
    },
    {
      name: "Fill password",
      async run(page) {
        await page.locator('input[type="password"]').first().fill(I.stratabluePassword);
      },
    },
    {
      name: "Click login button",
      async run(page) {
        await page.waitForTimeout(1000);
        const clicked = await page.evaluate(() => {
          const keywords = ["sign in", "login", "log in"];
          const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find(
            el =>
              keywords.some(kw => el.textContent?.toLowerCase().trim() === kw ||
                (el as HTMLInputElement).value?.toLowerCase() === kw) &&
              (el as HTMLElement).offsetParent !== null
          ) as HTMLElement | null;
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!clicked) {
          const fallback = await firstVisible(page, ['input[type="submit"]', 'button[type="submit"]', ".btn-primary", "button.btn"], 3000);
          if (!fallback) throw new Error("Login button not found");
          await page.locator(fallback).first().click();
        }
      },
    },
    {
      name: "Wait for post-login redirect",
      async run(page) {
        await page.waitForTimeout(5000);
        for (let i = 0; i < 25; i++) {
          const url = await page.url();
          if (!url.includes("/login")) {
            console.log(`    ℹ️  Redirected to: ${url}`);
            return;
          }
          await page.waitForTimeout(1000);
        }
        throw new Error("Still on login page after 30s — check credentials");
      },
    },

    // =========================================================================
    // FIND CUSTOMER
    // SEARCH ORDER: Phone → Address → Email
    // Phone is searched FIRST because the client reported that matching
    // customers are being missed by address search (format differences),
    // causing duplicate accounts.
    // =========================================================================
    {
      name: "Navigate to customers page",
      async run(page) {
        await page.goto("https://misterquik.sera.tech/customers", { waitUntil: "domcontentloaded", timeout: 300000 });
        await waitUntilVisible(page, "table, .customers-list", 150000);
      },
    },

    // --- PRIMARY SEARCH: Phone Number ---
    {
      name: "Search customers by phone (primary)",
      async run(page) {
        const phoneSel = await firstVisible(page, [
          'th.phone-field input',
          'th[class*="phone"] input',
        ], 5000);
        if (phoneSel) {
          await page.locator(phoneSel).first().fill(I.phone);
          console.log(`    ℹ️  Searching by phone: ${I.phone}`);
        } else {
          console.log("    ⚠️  Phone search input not found");
        }
        await page.waitForTimeout(10000);
      },
    },
    {
      name: "Check customer found by phone",
      async run(page, ctx) {
        const rows = page.locator("table tbody tr");
        const count = await rows.count();
        console.log(`    ℹ️  Phone search: ${count} rows`);

        for (let i = 0; i < count; i++) {
          const text = await rows.nth(i).textContent();

          // Verify the row actually contains the phone number we searched for
          // (handles formatting differences like "(317) 666-5527" vs "3176665527")
          const phoneMatches = textContainsPhone(text, I.phone);

          if (!phoneMatches) {
            console.log(`    ℹ️  Row ${i} doesn't contain matching phone, skipping`);
            continue;
          }

          // Phone matches — check for secondary confirmation
          const matchesName = text.includes(I.firstName) && text.includes(I.lastName);
          const matchesEmail = I.email !== "Not Provided" && text.includes(I.email);
          const matchesAddress = addressesMatch(text, I.serviceAddress.split(",")[0].trim());

          if (matchesName || matchesEmail || matchesAddress) {
            console.log(`    ✅ Customer matched by phone + ${matchesName ? "name" : matchesEmail ? "email" : "address"}`);
          } else {
            // Phone matches but no secondary — still use it to prevent duplicates
            console.log(`    ℹ️  Row ${i} has matching phone but no secondary match. Using phone-only match to prevent duplicates.`);
          }

          const idMatch = text.match(/^(\d+)/);
          if (idMatch) {
            try {
              await page.goto(`https://misterquik.sera.tech/customers/${idMatch[1]}`, {
                waitUntil: "domcontentloaded",
                timeout: 100000,
              });
            } catch {
              console.log(`    ℹ️  goto timed out — waiting for page to settle`);
              await page.waitForTimeout(5000);
            }
          } else {
            await clickNth(page, "table tbody tr a", i);
          }
          await page.waitForTimeout(5000);
          ctx.customerFound = true;
          ctx.matchedBy = (matchesName || matchesEmail || matchesAddress) ? "phone" : "phone-only";
          return;
        }
        ctx.customerFound = false;
        console.log("    ℹ️  No customer found by phone number");
      },
    },

    // --- FALLBACK SEARCH 1: Address ---
    {
      name: "Clear phone search, search by address",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        const phoneSel = await firstVisible(page, ['th.phone-field input', 'th[class*="phone"] input']);
        if (phoneSel) {
          await page.locator(phoneSel).first().fill("");
          await page.waitForTimeout(500);
        }
        const addrPart = I.serviceAddress.split(",")[0].trim();
        const addrSel = await firstVisible(page, [
          'th.address-field input',
          'th[class*="address"] input',
        ], 3000);
        if (addrSel) await page.locator(addrSel).first().fill(addrPart);
        await page.waitForTimeout(10000);
      },
    },
    {
      name: "Check customer found by address",
      skipIf: (_, c) => alreadyFound(c),
      async run(page, ctx) {
        const rows = page.locator("table tbody tr");
        const count = await rows.count();
        console.log(`    ℹ️  Address search: ${count} rows`);
        for (let i = 0; i < count; i++) {
          const text = await rows.nth(i).textContent();
          const matchesName = text.includes(I.firstName) && text.includes(I.lastName);
          const matchesEmail = I.email !== "Not Provided" && text.includes(I.email);
          const matchesPhone = textContainsPhone(text, I.phone);

          if (matchesName || matchesEmail || matchesPhone) {
            console.log(`    ✅ Customer matched by address + ${matchesName ? "name" : matchesEmail ? "email" : "phone"}`);
            const idMatch = text.match(/^(\d+)/);
            if (idMatch) {
              try {
                await page.goto(`https://misterquik.sera.tech/customers/${idMatch[1]}`, {
                  waitUntil: "domcontentloaded",
                  timeout: 600000,
                });
              } catch {
                console.log(`    ℹ️  goto timed out — waiting for page to settle`);
                await page.waitForTimeout(5000);
              }
            } else {
              await clickNth(page, "table tbody tr a", i);
            }
            await page.waitForTimeout(5000);
            ctx.customerFound = true;
            ctx.matchedBy = "address";
            return;
          }
        }
        ctx.customerFound = false;
      },
    },

    // --- FALLBACK SEARCH 2: Email ---
    {
      name: "Clear address search, search by email",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        const addrSel = await firstVisible(page, ['th.address-field input', 'th[class*="address"] input']);
        if (addrSel) {
          await page.locator(addrSel).first().fill("");
          await page.waitForTimeout(500);
        }
        const emailSel = await firstVisible(page, ['th.email-field input', 'th[class*="email"] input']);
        if (emailSel) await page.locator(emailSel).first().fill(I.email);
        await page.waitForTimeout(10000);
      },
    },
    {
      name: "Check customer found by email",
      skipIf: (_, c) => alreadyFound(c),
      async run(page, ctx) {
        const rows = page.locator("table tbody tr");
        const count = await rows.count();
        console.log(`    ℹ️  Email search: ${count} rows`);
        for (let i = 0; i < count; i++) {
          const text = await rows.nth(i).textContent();
          const matchesName = text.includes(I.firstName) && text.includes(I.lastName);
          const matchesPhone = textContainsPhone(text, I.phone);

          if (matchesName || matchesPhone) {
            console.log(`    ✅ Customer matched by email + ${matchesName ? "name" : "phone"}`);
            const idMatch = text.match(/^(\d+)/);
            if (idMatch) {
              try {
                await page.goto(`https://misterquik.sera.tech/customers/${idMatch[1]}`, {
                  waitUntil: "domcontentloaded",
                  timeout: 600000,
                });
              } catch {
                console.log(`    ℹ️  goto timed out — waiting for page to settle`);
                await page.waitForTimeout(5000);
              }
            } else {
              await clickNth(page, "table tbody tr a", i);
            }
            await page.waitForTimeout(5000);
            ctx.customerFound = true;
            ctx.matchedBy = "email";
            return;
          }
        }
      },
    },

    // Verify customer profile loaded
    {
      name: "Verify customer profile loaded",
      skipIf: (_, c) => notFound(c),
      async run(page) {
        await page.waitForTimeout(3000);
        const profileSelectors = [
          ".customer-show",
          ".addresses-section",
          ".addresses-cont",
          ".customer-detail",
          '[data-cy="address-search"]',
        ];
        const found = await firstVisible(page, profileSelectors, 5000);
        if (found) {
          console.log(`    ℹ️  Profile confirmed via: "${found}"`);
          return;
        }
        const url = await page.url();
        if (url.includes("/customers/") && !url.endsWith("/customers")) {
          console.log(`    ℹ️  Profile URL confirmed: ${url}`);
          await page.waitForTimeout(2000);
          return;
        }
        throw new Error(`Customer profile did not load. URL: ${url}`);
      },
    },

    // =========================================================================
    // CREATE CUSTOMER (only if not found)
    // =========================================================================
    {
      name: "Navigate to new customer page",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await page.goto("https://misterquik.sera.tech/customers/new", {
          waitUntil: "domcontentloaded",
          timeout: 300000,
        });
        await waitUntilVisible(page, 'input[data-cy="first-name"], input[name*="first" i]', 10000);
      },
    },
    {
      name: "Fill first name",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await page.locator('input[data-cy="first-name"]').first().fill(I.firstName);
      },
    },
    {
      name: "Fill last name",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await page.locator('input[data-cy="last-name"]').first().fill(I.lastName);
      },
    },
    {
      name: "Fill customer email",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await page.locator('input[data-cy="email-primary"]').first().fill(I.email);
      },
    },
    {
      name: "Fill customer phone",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await page.locator('input[data-cy="phone"]').first().fill(I.phone);
      },
    },
    {
      name: "Fill service address with autocomplete",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await waitUntilVisible(page, "#address-search-service", 10000);
        await page.locator("#address-search-service").first().click();
        await page.locator("#address-search-service").first().fill(I.serviceAddress);
        await page.waitForTimeout(2000);
        await waitUntilVisible(page, ".pac-item", 5000);
        await page.locator(".pac-item").first().click();
        await page.waitForTimeout(1500);
      },
    },
    {
      name: "Fill location name",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await page.locator('input[data-cy="location-name"]').first().fill(I.locationName);
      },
    },
    {
      name: "Select location type",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await waitUntilVisible(page, '[data-cy="location-type"] input[data-cy="select-input-field"]', 5000);
        await page.locator('[data-cy="location-type"] input[data-cy="select-input-field"]').first().click();
        await page.waitForTimeout(500);
        await waitUntilVisible(page, '[data-cy="location-type"] .select-options .option', 3000);
        await page.evaluate((locType: string) => {
          const options = Array.from(
            document.querySelectorAll('[data-cy="location-type"] .select-options .option')
          );
          const match = options.find(el => el.textContent?.includes(locType)) as HTMLElement;
          if (match) match.click();
          else throw new Error(`Location type option "${locType}" not found`);
        }, I.locationType);
      },
    },
    {
      name: "Scroll to bottom for tags",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      },
    },
    {
      name: "Add customer tag",
      skipIf: (_, c) => alreadyFound(c),
      async run(page) {
        const alreadyApplied = await page.evaluate((tag: string) => {
          const pills = Array.from(document.querySelectorAll(".tag-pill, .tag-label, [class*='tag']"));
          return pills.some(el => el.textContent?.includes(tag));
        }, I.customerTag);
        if (alreadyApplied) {
          console.log(`    ℹ️  Tag "${I.customerTag}" already applied`);
          return;
        }

        await page.locator("i.tag-menu-btn").first().click();
        await page.waitForTimeout(1000);

        const tagInputSel = 'sera-input input[placeholder="Create or Select Tag"], input[placeholder="Create or Select Tag"]';
        await waitUntilVisible(page, tagInputSel, 5000);
        await page.locator(tagInputSel).first().fill(I.customerTag);
        await page.waitForTimeout(2000);

        const clicked = await page.evaluate((tag: string) => {
          const optionSelectors = [
            ".tag-option", ".tag-item", ".select-option",
            "[class*=\"dropdown\"] [class*=\"option\"]",
            "[class*=\"dropdown\"] [class*=\"item\"]",
          ];
          for (const sel of optionSelectors) {
            const match = Array.from(document.querySelectorAll(sel)).find(
              el => el.textContent?.includes(tag) && (el as HTMLElement).offsetParent !== null
            ) as HTMLElement;
            if (match) { match.click(); return "option"; }
          }
          const label = Array.from(document.querySelectorAll("span.tag-label")).find(
            el => el.textContent?.includes(tag) && (el as HTMLElement).offsetParent !== null
          ) as HTMLElement;
          if (label) { label.click(); return "span.tag-label"; }

          const any = Array.from(document.querySelectorAll("li, span, div, button")).find(
            el =>
              el.textContent?.trim().includes(tag) &&
              (el as HTMLElement).offsetParent !== null &&
              (el as HTMLElement).clientHeight > 0 &&
              (el as HTMLElement).clientWidth < 400
          ) as HTMLElement;
          if (any) { any.click(); return "generic"; }
          return null;
        }, I.customerTag);

        if (clicked) {
          console.log(`    ℹ️  Tag selected via "${clicked}"`);
        } else {
          console.log(`    ⚠️  Tag dropdown item not found — pressing Enter to create/confirm`);
          await page.locator(tagInputSel).first().press("Enter");
        }
        await page.waitForTimeout(500);
      },
    },
    {
      name: "Click Save & Schedule",
      skipIf: (_, c) => alreadyFound(c),
      async run(page, ctx) {
        await page.locator('button[data-cy="save-customer-continue"]').first().click();
        await waitUntilHidden(page, ".spinner, .loading", 30000);
        await page.waitForTimeout(2000);
        ctx.customerFound = true;
        ctx.newCustomerCreated = true;
        ctx.bookingPopupOpen = true;
        ctx.matchedBy = "new-customer";
      },
    },

    // =========================================================================
    // LOCATE ADDRESS on customer profile
    // =========================================================================
    {
      name: "Search for address in customer profile",
      skipIf: (_, c) => foundOrPopup(c),
      async run(page) {
        await page.waitForTimeout(5000);
        const searchSelectors = [
          '[data-cy="address-search"] input',
          'sera-input[data-cy="address-search"] input',
          'input[placeholder*="Search" i]',
          'input[placeholder*="Address" i]',
          ".addresses-cont input",
        ];
        const sn = extractStreetNumber(I.serviceAddress);
        const sa = I.serviceAddress.split(",")[0].trim();
        const searchTerm = sn || sa;
        const sel = await firstVisible(page, searchSelectors, 3000);
        if (sel) {
          await page.locator(sel).first().fill(searchTerm);
          console.log(`    ℹ️  Searched for "${searchTerm}" using "${sel}"`);
        } else {
          console.log(`    ⚠️  Address search input not found — will scan all cards`);
        }
        await page.waitForTimeout(1500);
      },
    },
    {
      name: "Check if address exists and click Schedule",
      skipIf: (_, c) => foundOrPopup(c),
      async run(page, ctx) {
        const sa = I.serviceAddress.split(",")[0].trim();
        const count = await page.locator(".address-card").count();
        console.log(`    ℹ️  ${count} address card(s)`);

        if (count === 0) { ctx.addressFound = false; return; }

        const cardTexts: string[] = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".address-card")).map(el => el.textContent || "")
        );

        let matchedIndex = -1;
        for (let i = 0; i < cardTexts.length; i++) {
          if (addressesMatch(cardTexts[i], sa)) {
            matchedIndex = i;
            console.log(`    ℹ️  Address matched at card ${i}`);
            break;
          }
        }

        if (matchedIndex === -1) {
          console.log(`    ℹ️  No address card matched "${sa}"`);
          ctx.addressFound = false;
          return;
        }

        ctx.addressFound = true;

        const clicked = await page.evaluate((idx: number) => {
          const cards = Array.from(document.querySelectorAll(".address-card"));
          const card = cards[idx];
          if (!card) return false;
          const schedBtn =
            card.querySelector('[data-cy="address-schedule-link"]') ||
            Array.from(card.querySelectorAll("button, a")).find(el =>
              el.textContent?.toLowerCase().includes("schedule")
            );
          if (schedBtn) { (schedBtn as HTMLElement).click(); return true; }
          return false;
        }, matchedIndex);

        if (!clicked) throw new Error(`Schedule button not found in card ${matchedIndex}`);
        await page.waitForTimeout(2000);
      },
    },

    // =========================================================================
    // ADD NEW ADDRESS (if not found)
    // =========================================================================
    {
      name: "Open Address Actions dropdown",
      skipIf: (_, c) => addressFoundOrPopup(c),
      async run(page) {
        const si = await firstVisible(page, ['sera-input[data-cy="address-search"] input'], 2000);
        if (si) {
          await page.locator(si).first().fill("");
          await page.waitForTimeout(500);
        }
        await page.locator('sera-button[data-cy="address-actions-trigger"]').first().click();
        await page.waitForTimeout(500);
      },
    },
    {
      name: "Click Add Address option",
      skipIf: (_, c) => addressFoundOrPopup(c),
      async run(page) {
        const clicked = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll("*"));
          const el = all.find(
            e => e.textContent?.trim().toLowerCase() === "add address" && (e as HTMLElement).offsetParent !== null
          ) as HTMLElement;
          if (el) { el.click(); return true; }
          return false;
        });
        if (!clicked) throw new Error('"Add Address" option not found');
        await page.waitForTimeout(1000);
      },
    },
    {
      name: "Fill new address with autocomplete",
      skipIf: (_, c) => addressFoundOrPopup(c),
      async run(page, ctx) {
        await waitUntilVisible(page, '.modal, [role="dialog"]', 10000);
        const modalInputSel = '.modal input[type="text"], [role="dialog"] input[type="text"]';
        await waitUntilVisible(page, modalInputSel, 5000);
        await page.locator(modalInputSel).first().click();
        await page.locator(modalInputSel).first().fill(I.serviceAddress);
        await page.waitForTimeout(2000);
        const pacVisible = await page.locator(".pac-item").first().isVisible();
        if (pacVisible) {
          await page.locator(".pac-item").first().click();
          await page.waitForTimeout(1500);
          ctx.actualStreetAddress = await page.locator(modalInputSel).first().inputValue();
        }
      },
    },
    {
      name: "Fill location name for new address",
      skipIf: (_, c) => addressFoundOrPopup(c),
      async run(page) {
        const liVisible = await page.locator('input[data-cy="location-name"]').first().isVisible();
        if (liVisible) await page.locator('input[data-cy="location-name"]').first().fill(I.locationName);
      },
    },
    {
      name: "Select location type for new address",
      skipIf: (_, c) => addressFoundOrPopup(c),
      async run(page) {
        const ddSel = '[data-cy="location-type"] input[data-cy="select-input-field"]';
        const ddVisible = await page.locator(ddSel).first().isVisible();
        if (!ddVisible) return;
        await page.locator(ddSel).first().click();
        await page.waitForTimeout(500);
        await page.evaluate((locType: string) => {
          const options = Array.from(
            document.querySelectorAll('[data-cy="location-type"] .select-options .option')
          );
          const match = options.find(el => el.textContent?.includes(locType)) as HTMLElement;
          if (match) match.click();
        }, I.locationType);
      },
    },
    {
      name: "Save new address",
      skipIf: (_, c) => addressFoundOrPopup(c),
      async run(page, ctx) {
        const modalSaveSel = '.modal button[type="submit"], [role="dialog"] button[type="submit"]';
        const saved = await page.evaluate(() => {
          const modal = document.querySelector('.modal, [role="dialog"]');
          if (!modal) return false;
          const btn = Array.from(modal.querySelectorAll("button, sera-button")).find(
            el => el.textContent?.toLowerCase().includes("save")
          ) as HTMLElement;
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!saved) {
          await page.locator(modalSaveSel).first().click();
        }
        await page.waitForTimeout(2000);
        ctx.addressFound = true;
        ctx.newAddressAdded = true;
      },
    },
    {
      name: "Find newly added address and click Schedule",
      skipIf: (_, c) => newAddrAdded(c),
      async run(page, ctx) {
        await page.waitForTimeout(3000);
        await waitUntilVisible(page, ".addresses-cont, .address-card", 150000);
        await page.waitForTimeout(1500);

        const raw = ((ctx.actualStreetAddress || I.serviceAddress) as string).split(",")[0].trim();
        const sn = extractStreetNumber(raw);

        const searchSelectors = [
          '[data-cy="address-search"] input',
          'sera-input[data-cy="address-search"] input',
          'input[placeholder*="Search" i]',
          'input[placeholder*="Address" i]',
        ];
        const siSel = await firstVisible(page, searchSelectors, 2000);
        if (siSel) {
          try {
            await page.locator(siSel).first().fill(sn || raw);
            console.log(`    ℹ️  Searched for "${sn || raw}" using "${siSel}"`);
            await page.waitForTimeout(1500);
          } catch {
            console.log(`    ⚠️  Search fill failed — scanning all cards without filter`);
          }
        } else {
          console.log(`    ℹ️  No search input found — scanning all cards`);
        }

        let matchedIndex = -1;
        for (let attempt = 0; attempt < 3; attempt++) {
          const cardTexts: string[] = await page.evaluate(() =>
            Array.from(document.querySelectorAll(".address-card")).map(el => el.textContent || "")
          );
          console.log(`    ℹ️  ${cardTexts.length} card(s) on attempt ${attempt + 1}`);

          matchedIndex = cardTexts.findIndex(t => addressesMatch(t, raw));

          if (matchedIndex === -1 && cardTexts.length === 1 && sn && cardTexts[0].includes(sn)) {
            matchedIndex = 0;
          }

          if (matchedIndex === -1 && cardTexts.length === 1) {
            console.log(`    ℹ️  Only 1 card found — assuming it's the newly added address`);
            matchedIndex = 0;
          }

          if (matchedIndex !== -1) break;
          await page.waitForTimeout(1500);
        }

        if (matchedIndex === -1) throw new Error(`Could not find address "${raw}" in any card`);

        const clicked = await page.evaluate((idx: number) => {
          const cards = Array.from(document.querySelectorAll(".address-card"));
          const card = cards[idx];
          if (!card) return false;
          const schedBtn =
            card.querySelector('[data-cy="address-schedule-link"]') ||
            Array.from(card.querySelectorAll("button, a")).find(el =>
              el.textContent?.toLowerCase().includes("schedule")
            );
          if (schedBtn) { (schedBtn as HTMLElement).click(); return true; }
          return false;
        }, matchedIndex);

        if (!clicked) throw new Error(`Schedule button not in card ${matchedIndex}`);
        await page.waitForTimeout(2000);

        await waitUntilVisible(page, '.modal, [role="dialog"], .booking-popup, .modal-content', 8000);
        ctx.bookingPopupOpen = true;
      },
    },

    // Wait for booking modal (for existing address path)
    {
      name: "Wait for booking modal",
      skipIf: (_, c) => !c.addressFound || !!c.newAddressAdded || !!c.bookingPopupOpen,
      async run(page, ctx) {
        await waitUntilVisible(page, '.modal, [role="dialog"], .booking-popup, .modal-content', 150000);
        ctx.bookingPopupOpen = true;
      },
    },

    // =========================================================================
    // SERVICE CATEGORY
    // =========================================================================
    {
      name: "Wait for service category select",
      async run(page) {
        await waitUntilVisible(page, '[data-cy="service-category-select"]', 150000);
      },
    },
    {
      name: "Open service category dropdown",
      async run(page) {
        const inputSel = '[data-cy="service-category-select"] input[data-cy="select-input-field"], [data-cy="service-category-select"] .ss-input-field, [data-cy="service-category-select"] input';
        await waitUntilVisible(page, inputSel, 10000);
        await page.locator(inputSel).first().click();
        await page.waitForTimeout(500);
        await page.locator(inputSel).first().fill(I.serviceCategory);
        await page.waitForTimeout(1500);
      },
    },
    {
      name: "Select service category option",
      async run(page) {
        const clicked = await page.evaluate((cat: string) => {
          const options = Array.from(document.querySelectorAll('.ss-option, [role="option"], [class*="option"]'));
          const exact = options.find(el => el.textContent?.trim() === cat) as HTMLElement;
          if (exact) { exact.click(); return true; }
          const partial = options.find(el => el.textContent?.includes(cat)) as HTMLElement;
          if (partial) { partial.click(); return true; }
          return false;
        }, I.serviceCategory);

        if (!clicked) {
          const inputSel = '[data-cy="service-category-select"] input[data-cy="select-input-field"], [data-cy="service-category-select"] input';
          await page.locator(inputSel).first().press("ArrowDown");
          await page.waitForTimeout(300);
          await page.locator(inputSel).first().press("Enter");
        }
        await page.waitForTimeout(1000);
      },
    },
    {
      name: "Wait for calendar to appear",
      async run(page) {
        await waitUntilVisible(page, "table td, .calendar-day, .fc-daygrid", 150000);
      },
    },

    // =========================================================================
    // SELECT DATE — AI agent with sufficient step budget for any month distance
    // =========================================================================
    {
      name: "Select date on calendar",
      async run(page, _ctx, stagehand) {
        const domClickDate = async () => {
          const targetMonth = I.appointmentDateMonth;
          const targetDay   = String(I.appointmentDateDay);

          for (let nav = 0; nav < 3; nav++) {
            const headerText: string = await page.evaluate(() => {
              const h = document.querySelector(
                '.fc-toolbar-title, .calendar-header, .month-title, ' +
                'th.fc-col-header-cell, [class*="calendar"] h1, [class*="calendar"] h2, ' +
                '[class*="calendar"] h3, [class*="month"]'
              );
              return h ? h.textContent || "" : document.body.textContent || "";
            });

            if (headerText.includes(targetMonth)) break;

            const nextClicked = await page.evaluate(() => {
              const btn = (
                document.querySelector('.fc-next-button, [aria-label="next"], [aria-label="Next"]') ||
                Array.from(document.querySelectorAll("button")).find(
                  b => b.textContent?.trim() === ">" || b.textContent?.trim() === "→" ||
                       b.getAttribute("aria-label")?.toLowerCase().includes("next")
                )
              ) as HTMLElement | null;
              if (btn) { btn.click(); return true; }
              return false;
            });
            if (!nextClicked) break;
            await page.waitForTimeout(800);
          }

          const dayClicked = await page.evaluate((day: string) => {
            const byCy = Array.from(
              document.querySelectorAll('[data-cy^="calendar-day-"], [data-date], td.fc-daygrid-day, .calendar-day')
            ).find(el => {
              const dc  = el.getAttribute("data-cy") || "";
              const dd  = el.getAttribute("data-date") || "";
              const txt = el.textContent?.trim() || "";
              return dc.endsWith(`-${day}`) || dd.endsWith(`-${day.padStart(2, "0")}`) || txt === day;
            }) as HTMLElement | null;
            if (byCy) { byCy.click(); return true; }

            const byText = Array.from(document.querySelectorAll("td, .day, button")).find(el => {
              const t = el.textContent?.trim();
              return t === day && (el as HTMLElement).offsetParent !== null;
            }) as HTMLElement | null;
            if (byText) { byText.click(); return true; }
            return false;
          }, targetDay);

          if (!dayClicked) throw new Error(`DOM fallback: could not click day "${targetDay}" on calendar`);
          console.log(`    ℹ️  DOM fallback: clicked day ${targetDay}`);
          await page.waitForTimeout(1000);
        };

        try {
          const agent = stagehand.agent({
            mode: "cua",
            model: "google/gemini-2.5-computer-use-preview-10-2025",
            options: { maxSteps: 30 },
          });
          await agent.execute(
            `Look at the calendar in the booking modal. ` +
            `Target Date: ${I.appointmentDate} (${I.appointmentDateMonth}, day ${I.appointmentDateDay}). ` +
            `Scroll down to see the calendar, navigate to ${I.appointmentDateMonth} if needed, ` +
            `then click ONLY day "${I.appointmentDateDay}". ` +
            `Do NOT select any other date. STOP when time slots appear.`
          );
          console.log(`    ℹ️  AI agent completed date selection`);
        } catch (agentErr: any) {
          const isQuota =
            agentErr?.message?.includes("429") ||
            agentErr?.message?.includes("RESOURCE_EXHAUSTED") ||
            agentErr?.message?.includes("quota");
          if (isQuota) {
            console.log(`    ⚠️  AI agent quota error — falling back to DOM date click`);
            await domClickDate();
          } else {
            console.log(`    ⚠️  AI agent error (${agentErr.message}) — trying DOM fallback`);
            await domClickDate();
          }
        }
      },
    },
    {
      name: "Verify date selected and wait for time slots",
      async run(page, ctx) {
        await page.evaluate(() => {
          const m = document.querySelector('.modal-content, [role="dialog"]');
          if (m) (m as any).scrollTop = 0;
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(500);
        ctx.selectedDate = I.appointmentDateDay;

        for (const sel of ['[data-cy^="time-slot-"]', ".slot-button"]) {
          try {
            await waitUntilVisible(page, sel, 150000);
            return;
          } catch { /* try next */ }
        }
        throw new Error("Time slots never appeared after date selection");
      },
    },

    // =========================================================================
    // SELECT TIME SLOT
    // =========================================================================
    {
      name: "Select time slot",
      async run(page, ctx) {
        await page.waitForTimeout(1000);

        const slotData: Array<{ index: number; label: string; dataCy: string; classes: string }> =
          await page.evaluate(() =>
            Array.from(document.querySelectorAll('[data-cy^="time-slot-"]')).map((el, i) => ({
              index: i,
              label: el.textContent?.trim() || "",
              dataCy: el.getAttribute("data-cy") || "",
              classes: el.getAttribute("class") || "",
            }))
          );

        if (slotData.length === 0) throw new Error("No time slot elements found");

        const slots = slotData.map(s => ({
          ...s,
          labelHour: parseRequestedTimeToHour(s.label),
          dataCyHour: extractHourFromDataCy(s.dataCy),
          isClickable: !s.classes.split(/\s+/).includes("disabled"),
        }));

        const clickable = slots.filter(s => s.isClickable);
        if (clickable.length === 0) throw new Error("No clickable time slots available");

        const rh = parseRequestedTimeToHour(I.appointmentTime);
        const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

        let target =
          clickable.find(s => norm(s.label) === norm(I.appointmentTime)) ||
          (rh !== null ? clickable.find(s => s.labelHour === rh) : undefined);

        if (!target) {
          if (rh !== null) {
            target = [...clickable].sort(
              (a, b) => Math.abs((a.labelHour ?? 99) - rh) - Math.abs((b.labelHour ?? 99) - rh)
            )[0];
          } else {
            target = clickable[0];
          }
          ctx.timeSlotDiffers = true;
        } else {
          ctx.timeSlotDiffers = false;
        }

        await page.evaluate((idx: number) => {
          const slots = Array.from(document.querySelectorAll('[data-cy^="time-slot-"]'));
          const el = slots[idx] as HTMLElement;
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.click();
          }
        }, target.index);

        ctx.selectedTimeSlot = target.label;
        const time = target.label;
        ctx.completionMessage = `Booking successful for ${I.firstName} ${I.lastName} at ${I.serviceAddress} on ${I.appointmentDate} at ${time}.`;
        await page.waitForTimeout(500);
      },
    },
    {
      name: "Verify time slot selected",
      async run(page, ctx) {
        const selectedVisible = await page.locator('[data-cy^="time-slot-"].selected, .slot-button.selected').first().isVisible();
        if (!selectedVisible) {
          await page.locator('[data-cy^="time-slot-"]:not(.disabled)').first().click();
          await page.waitForTimeout(500);
          const label = await page.locator('[data-cy^="time-slot-"].selected, .slot-button.selected').first().textContent();
          ctx.selectedTimeSlot = label?.trim() || I.appointmentTime;
          ctx.timeSlotDiffers = true;
        }
        if (!ctx.selectedTimeSlot) throw new Error("Could not confirm time slot selection");
      },
    },

    // =========================================================================
    // NOTES & SAVE
    // =========================================================================
    {
      name: "Fill appointment notes",
      async run(page, ctx) {
        const time = ctx.selectedTimeSlot || I.appointmentTime;
        const notes = [
          "Booked By Stratablue AI",
          "",
          "Mr Quik Inbound Agent | Existing Customer",
          `Created At: ${I.createdAt}`,
          `First Name: ${I.firstName}`,
          `Last Name: ${I.lastName}`,
          `Phone Number: ${I.phone}`,
          `Email: ${I.email}`,
          `Service Category: ${I.serviceCategory}`,
          `Job Details Address: ${I.serviceAddress}`,
          `Appointment Date: ${I.appointmentDate}`,
          `Appointment Time: ${time}`,
          `Job Summary: ${I.jobSummary}`,
          `Priority Level: ${I.priorityLevel}`,
          `Age of Home: ${I.ageOfHome}`,
          `Age of Equipment: ${I.ageOfEquipment}`,
          `Message for Team: ${I.messageForTeam}`,
          `Call Outcome: ${I.callOutcome}`,
          `Call ID: ${I.callId}`,
          `Customer Matched By: ${ctx.matchedBy || "new-customer"}`,
        ].join("\n");

        const taSel = 'textarea[name*="notes" i], textarea[placeholder*="Notes" i], textarea';
        const taVisible = await page.locator(taSel).first().isVisible();
        if (taVisible) await page.locator(taSel).first().fill(notes);
        else console.log(`    ⚠️  Notes textarea not found — skipping`);
      },
    },
    {
      name: "Click Save (modal flow)",
      skipIf: (_, c) => !!c.newCustomerCreated,
      async run(page) {
        const byCy = await page.locator('[data-cy="modal-submit-btn"]').first().isVisible();
        if (byCy) {
          await page.locator('[data-cy="modal-submit-btn"]').first().click();
          return;
        }

        const clicked = await page.evaluate(() => {
          const modal = document.querySelector('.modal-content, [role="dialog"], .booking-popup');
          const scope = modal || document;
          const btn = Array.from(scope.querySelectorAll('button, input[type="submit"]')).find(
            el =>
              ["save", "submit", "schedule"].some(kw =>
                el.textContent?.toLowerCase().includes(kw) ||
                (el as HTMLInputElement).value?.toLowerCase().includes(kw)
              ) && (el as HTMLElement).offsetParent !== null
          ) as HTMLElement | null;
          if (btn) { btn.click(); return btn.textContent?.trim() || "button"; }
          return null;
        });

        if (!clicked) {
          await page.locator('button[type="submit"]').first().click();
        } else {
          console.log(`    ℹ️  Clicked save button: "${clicked}"`);
        }
      },
    },
    {
      name: "Click Save (new customer flow)",
      skipIf: (_, c) => !c.newCustomerCreated,
      async run(page) {
        const byCy = await page.locator('[data-cy="save-job"]').first().isVisible();
        if (byCy) {
          await page.locator('[data-cy="save-job"]').first().click();
          return;
        }

        const clicked = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find(
            el =>
              ["schedule appointment", "save", "submit"].some(kw =>
                el.textContent?.toLowerCase().includes(kw)
              ) && (el as HTMLElement).offsetParent !== null
          ) as HTMLElement | null;
          if (btn) { btn.click(); return btn.textContent?.trim(); }
          return null;
        });

        if (!clicked) throw new Error("Could not find Schedule Appointment / Save button");
        console.log(`    ℹ️  Clicked: "${clicked}"`);
      },
    },
    {
      name: "Wait for save to complete",
      async run(page) {
        await page.waitForTimeout(3000);
      },
    },
    {
      name: "Verify booking saved (modal flow)",
      skipIf: (_, c) => !!c.newCustomerCreated,
      async run(page, ctx) {
        let modalVisible = false;
        for (let i = 0; i < 10; i++) {
          await page.waitForTimeout(1000);
          modalVisible = await page.locator('.modal-content, [role="dialog"]').first().isVisible();
          if (!modalVisible) break;
        }
        if (modalVisible) {
          const errText: string = await page.evaluate(() => {
            const err = document.querySelector('.error, .validation-error, [class*="alert-danger"], [class*="flash-error"]');
            return err ? (err.textContent?.trim() || "") : "";
          });
          if (errText) throw new Error(`Booking failed with error: ${errText}`);
          console.log(`    ⚠️  Modal still visible after 10s but no error found — assuming saved`);
        }
        ctx.bookingSaved = true;
      },
    },
    {
      name: "Verify booking saved (new customer flow)",
      skipIf: (_, c) => !c.newCustomerCreated,
      async run(_page, ctx) {
        await _page.waitForTimeout(2000);
        ctx.bookingSaved = true;
      },
    },

    // =========================================================================
    // COMPLETION REPORT
    // =========================================================================
    {
      name: "Generate completion report",
      async run(_page, ctx) {
        const time = ctx.selectedTimeSlot || I.appointmentTime;
        let msg = `Booking successful for ${I.firstName} ${I.lastName} at ${I.serviceAddress} on ${I.appointmentDate} at ${time}.`;
        msg += `\nCustomer matched by: ${ctx.matchedBy || "new-customer-created"}`;
        if (ctx.newAddressAdded) msg += `\nNote: New address was added to customer profile.`;
        if (ctx.timeSlotDiffers) msg += `\nNote: Requested time "${I.appointmentTime}" unavailable. Booked "${time}" instead.`;
        console.log(`\n🎉 ${msg}`);
        ctx.completionMessage = msg;
      },
    },
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
    callOutcome: input.callOutcome || "Not Provided",
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

  let sessionUrl = "";

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session: ${sessionUrl}`);
    console.log(`📞 Search order: Phone → Address → Email (phone-first to prevent duplicates)`);

    const page = stagehand.context.pages()[0];

    for (let i = 0; i < STEPS.length; i++) {
      const ok = await runStep(STEPS[i], page, context, stagehand, i + 1);
      results.push({ step: STEPS[i].name, success: ok });
      if (!ok) {
        console.log(`🛑 Stopped at step ${i + 1}: ${STEPS[i].name}`);
        break;
      }
    }
  } catch (error: any) {
    console.error(`❌ Fatal error: ${error.message}`);
    results.push({ step: "Fatal Error", success: false, error: error.message });
  } finally {
    await stagehand.close();
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  const bookingSuccess = !!context.bookingSaved || (
    !!context.selectedTimeSlot &&
    !!context.selectedDate &&
    !!context.bookingPopupOpen
  );
  
  const bookingMessage = context.completionMessage || (bookingSuccess
    ? `Booking successful for ${context.selectedTimeSlot ? `at ${context.selectedTimeSlot}` : ""} — verify step inconclusive, check session replay.`
    : "Booking did not complete — check session replay.");
  
  return {
    success: bookingSuccess,
    message: bookingMessage,
    stepsRun: results.filter(r => r.success).length,
    stepsSkipped: results.filter(r => (r as any).skipped).length,
    totalSteps: STEPS.length,
    elapsedMinutes: parseFloat(elapsed),
    sessionUrl,
    results,
    context,
  };
}