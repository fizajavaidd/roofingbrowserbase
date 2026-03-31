// decline-quotes-module.ts
// For each appointment on a filtered page:
//   1. Gets the JOB ID from the table
//   2. Opens job in Quotes tab via direct URL
//   3. Finds all open quotes and declines them
//   4. Moves to next job

import { Stagehand } from "@browserbasehq/stagehand";
import * as fs from "fs";
import * as path from "path";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

// ==================== LOGGER ====================

function createLogger(dateFilter: string, pageNumber: number) {
  const logsDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeDateFilter = dateFilter.replace(/[^a-zA-Z0-9\-_]/g, "_");
  const logFileName = `decline-quotes_page-${pageNumber}_${safeDateFilter}_${timestamp}.log`;
  const logFilePath = path.join(logsDir, logFileName);

  const startTime = Date.now();

  function formatTimestamp(): string {
    return new Date().toISOString();
  }

  function elapsedSeconds(): string {
    return `+${((Date.now() - startTime) / 1000).toFixed(2)}s`;
  }

  function write(level: string, message: string, data?: any): void {
    const line = [
      formatTimestamp(),
      elapsedSeconds(),
      `[${level}]`,
      message,
      data !== undefined ? JSON.stringify(data) : "",
    ]
      .filter(Boolean)
      .join("  ");

    // Write to file
    fs.appendFileSync(logFilePath, line + "\n", "utf8");

    // Mirror to console
    console.log(line);
  }

  return {
    logFilePath,

    info: (msg: string, data?: any) => write("INFO ", msg, data),
    success: (msg: string, data?: any) => write("OK   ", msg, data),
    warn: (msg: string, data?: any) => write("WARN ", msg, data),
    error: (msg: string, data?: any) => write("ERROR", msg, data),
    debug: (msg: string, data?: any) => { if (DEBUG) write("DEBUG", msg, data); },

    section: (title: string) => {
      const bar = "=".repeat(60);
      const line = `\n${bar}\n  ${title}\n${bar}`;
      fs.appendFileSync(logFilePath, line + "\n", "utf8");
      console.log(line);
    },

    summary: (stats: {
      jobsProcessed: number;
      quotesDeclined: number;
      errors: string[];
      sessionUrl: string;
    }) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      const lines = [
        "",
        "=".repeat(60),
        "  RUN SUMMARY",
        "=".repeat(60),
        `  Date Filter    : ${dateFilter}`,
        `  Page Number    : ${pageNumber}`,
        `  Jobs Processed : ${stats.jobsProcessed}`,
        `  Quotes Declined: ${stats.quotesDeclined}`,
        `  Total Elapsed  : ${elapsed}s`,
        `  Session URL    : ${stats.sessionUrl}`,
        `  Errors (${stats.errors.length}):`,
        ...stats.errors.map((e, i) => `    ${i + 1}. ${e}`),
        "=".repeat(60),
        "",
      ].join("\n");

      fs.appendFileSync(logFilePath, lines + "\n", "utf8");
      console.log(lines);
    },
  };
}

// ================================================

export async function declineQuotesOnPage(input: {
  dateFilter: string;
  pageNumber: number;
}): Promise<{
  status: string;
  result: string;
  jobsProcessed: number;
  quotesDeclined: number;
  sessionUrl: string;
  logFilePath: string;
}> {
  const EMAIL = process.env.STRATABLUE_EMAIL || "mcc@stratablue.com";
  const PASSWORD = process.env.STRATABLUE_PASSWORD || "";
  const { dateFilter, pageNumber } = input;

  const log = createLogger(dateFilter, pageNumber);
  const errors: string[] = [];

  log.section(`DECLINE QUOTES — Page ${pageNumber} | Filter: ${dateFilter}`);
  log.info("Run started", { dateFilter, pageNumber, email: EMAIL });

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: "google/gemini-2.5-flash",
    verbose: DEBUG ? 2 : 1,
    disablePino: !DEBUG,
  });

  let sessionUrl = "";
  let jobsProcessed = 0;
  let quotesDeclined = 0;

  async function safeGoto(page: any, url: string, waitMs: number = 5000) {
    log.debug(`safeGoto → ${url}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 60000 });
    } catch {
      log.warn(`Page load timed out — continuing anyway`, { url });
    }
    await page.waitForTimeout(waitMs);
  }

  try {
    // ==================== INIT ====================
    log.section("STEP 0 — Stagehand Init");
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    log.success("Stagehand initialized", { sessionUrl });

    const page = stagehand.context.pages()[0];

    // ==================== STEP 1: LOGIN ====================
    log.section("STEP 1 — Login");
    log.info("Navigating to login page");
    await safeGoto(page, "https://misterquik.sera.tech/admins/login", 3000);

    log.info("Filling credentials");
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(1000);

    const loginSelectors = ['input[type="submit"]', 'button[type="submit"]', 'button.btn-primary'];
    let loginButtonClicked = false;
    for (const sel of loginSelectors) {
      try {
        const vis = await page.locator(sel).first().isVisible();
        if (vis) {
          log.info(`Clicking login button`, { selector: sel });
          await page.locator(sel).first().click();
          loginButtonClicked = true;
          break;
        }
      } catch {}
    }
    if (!loginButtonClicked) {
      log.warn("No login button found via selectors — form may have auto-submitted");
    }

    await page.waitForTimeout(5000);
    if (page.url().includes("/login")) {
      const msg = "Login failed — still on login page after submit";
      log.error(msg, { currentUrl: page.url() });
      throw new Error(msg);
    }
    log.success("Logged in successfully", { currentUrl: page.url() });

    // ==================== STEP 2: APPOINTMENTS ====================
    log.section("STEP 2 — Navigate to Filtered Appointments");
    const appointmentsUrl = `https://misterquik.sera.tech/reports/appointments?jobs-table_scheduled_time=${encodeURIComponent(dateFilter)}&jobs-table_status=completed`;
    log.info("Navigating to appointments", { appointmentsUrl });
    await safeGoto(page, appointmentsUrl, 15000);
    log.success("Appointments page loaded", { currentUrl: page.url() });

    // ==================== STEP 3: PAGINATION ====================
    if (pageNumber > 1) {
      log.section(`STEP 3 — Navigate to Page ${pageNumber}`);
      log.info(`Attempting to click page ${pageNumber} in pagination`);
      const clicked = await page.evaluate((pn: number) => {
        const links = document.querySelectorAll('ul.pagination a.page-link, .dt-paging-button a, .page-item a');
        for (const link of links) {
          if (link.textContent?.trim() === String(pn)) {
            (link as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, pageNumber);

      if (!clicked) {
        log.warn(`DOM click failed for page ${pageNumber} — trying AI action`);
        await stagehand.act(`click on page number ${pageNumber} in the pagination at the bottom`);
      } else {
        log.info(`Clicked page ${pageNumber} via DOM`);
      }
      await page.waitForTimeout(5000);
      log.success(`Now on page ${pageNumber}`);
    }

    // ==================== STEP 4: COLLECT JOB IDS ====================
    log.section("STEP 4 — Collect Job IDs");
    log.info("Scanning table rows for job IDs");

    const jobIds: string[] = await page.evaluate(() => {
      const ids: string[] = [];
      const rows = document.querySelectorAll('table tbody tr, tbody.table-data tr');
      for (const row of rows) {
        const firstJobLink = row.querySelector('a[href*="/jobs/"]');
        if (firstJobLink) {
          const href = firstJobLink.getAttribute('href') || '';
          const match = href.match(/\/jobs\/(\d+)/);
          if (match) { ids.push(match[1]); continue; }
        }
        const cells = row.querySelectorAll('td');
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          if (/^\d{6,}$/.test(text)) { ids.push(text); break; }
        }
      }
      return ids;
    });

    log.info(`Primary method found ${jobIds.length} job IDs`, { jobIds: jobIds.slice(0, 20) });

    if (jobIds.length === 0) {
      log.warn("No job IDs found via primary method — trying fallback");
      const fallbackIds: string[] = await page.evaluate(() => {
        const ids: string[] = [];
        const rows = document.querySelectorAll('table tbody tr, tbody.table-data tr');
        for (const row of rows) {
          const link = row.querySelector('a[href*="/jobs/"]');
          if (link) {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/jobs\/(\d+)/);
            if (match) { ids.push(match[1]); }
          }
        }
        return ids;
      });

      if (fallbackIds.length === 0) {
        log.warn("Fallback also found no job IDs — page may be empty");
        log.summary({ jobsProcessed: 0, quotesDeclined: 0, errors, sessionUrl });
        await stagehand.close();
        return {
          status: "COMPLETED",
          result: `Page ${pageNumber}: No jobs found`,
          jobsProcessed: 0,
          quotesDeclined: 0,
          sessionUrl,
          logFilePath: log.logFilePath,
        };
      }

      jobIds.push(...fallbackIds);
      log.info(`Fallback found ${fallbackIds.length} job IDs`, { jobIds: fallbackIds.slice(0, 20) });
    }

    log.success(`Total job IDs to process: ${jobIds.length}`, { jobIds });

    // ==================== STEP 5: PROCESS EACH JOB ====================
    log.section("STEP 5 — Process Jobs");

    for (const jobId of jobIds) {
      log.info(`──────────────────────────────────────`);
      log.info(`Processing job`, { jobId });

      try {
        const jobQuotesUrl = `https://misterquik.sera.tech/jobs/${jobId}?tab=jp_Quotes`;
        log.info(`Opening Quotes tab in new browser tab`, { jobQuotesUrl });

        const newPage = await stagehand.context.newPage();
        try {
          await newPage.goto(jobQuotesUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        } catch {
          log.warn(`Job page load timed out — continuing`, { jobId });
        }
        await newPage.waitForTimeout(5000);
        log.success(`Quotes tab opened`, { jobId });

        let hasMoreOpenQuotes = true;
        let quotesOnThisJob = 0;
        const MAX_QUOTES_PER_JOB = 20;

        while (hasMoreOpenQuotes && quotesOnThisJob < MAX_QUOTES_PER_JOB) {
          log.info(`Scanning for open quotes`, { jobId, attemptNumber: quotesOnThisJob + 1 });

          // --- Check for open quotes ---
          const openQuoteInfo = await newPage.evaluate(() => {
            const headers = document.querySelectorAll('.group-header, [class*="quote-group"]');
            let openSection: Element | null = null;
            for (const h of headers) {
              if (h.textContent?.trim().toLowerCase().startsWith('open')) {
                openSection = h.closest('.quote-group') || h.parentElement;
                break;
              }
            }
            if (!openSection) {
              const allDivs = document.querySelectorAll('div');
              for (const div of allDivs) {
                const directText = Array.from(div.childNodes)
                  .filter(n => n.nodeType === 3)
                  .map(n => n.textContent?.trim())
                  .join('');
                if (directText === 'Open') {
                  openSection = div.closest('[class*="quote-group"]') || div.parentElement?.parentElement;
                  break;
                }
              }
            }
            if (!openSection) return { hasOpen: false, count: 0 };
            const actionTriggers = openSection.querySelectorAll('[data-cy="action-trigger-icon"], .action-trigger, .fa-ellipsis-v');
            return { hasOpen: actionTriggers.length > 0, count: actionTriggers.length };
          });

          if (!openQuoteInfo.hasOpen) {
            if (quotesOnThisJob === 0) {
              log.info(`No open quotes found — skipping job`, { jobId });
            } else {
              log.success(`All open quotes declined for job`, { jobId, total: quotesOnThisJob });
            }
            hasMoreOpenQuotes = false;
            break;
          }

          log.info(`Open quotes detected`, { jobId, count: openQuoteInfo.count });

          // --- Click three dots ---
          log.info(`Clicking three-dot menu on first open quote`, { jobId });
          const dotsClicked = await newPage.evaluate(() => {
            const headers = document.querySelectorAll('.group-header, [class*="quote-group"]');
            let openSection: Element | null = null;
            for (const h of headers) {
              if (h.textContent?.trim().toLowerCase().startsWith('open')) {
                openSection = h.closest('.quote-group') || h.parentElement;
                break;
              }
            }
            if (!openSection) {
              const allDivs = document.querySelectorAll('div');
              for (const div of allDivs) {
                const directText = Array.from(div.childNodes)
                  .filter(n => n.nodeType === 3)
                  .map(n => n.textContent?.trim())
                  .join('');
                if (directText === 'Open') {
                  openSection = div.closest('[class*="quote-group"]') || div.parentElement?.parentElement;
                  break;
                }
              }
            }
            if (!openSection) return false;
            const trigger = openSection.querySelector('[data-cy="action-trigger-icon"], .action-trigger, .fa-ellipsis-v, i.fa-ellipsis-v');
            if (trigger) { (trigger as HTMLElement).click(); return true; }
            const wrapper = openSection.querySelector('.actions-menu-wrapper, .action-menu-cont');
            if (wrapper) { (wrapper as HTMLElement).click(); return true; }
            return false;
          });

          if (!dotsClicked) {
            log.warn(`DOM click failed for three-dot menu — trying AI`, { jobId });
            try {
              await stagehand.act("click the three dots menu icon next to the first quote under the Open section");
              log.info(`AI successfully clicked three-dot menu`, { jobId });
            } catch (aiErr: any) {
              log.error(`AI also failed to click three-dot menu — skipping job`, { jobId, error: aiErr.message });
              errors.push(`Job ${jobId}: Failed to click three-dot menu — ${aiErr.message}`);
              hasMoreOpenQuotes = false;
              break;
            }
          } else {
            log.info(`Three-dot menu clicked via DOM`, { jobId });
          }

          await newPage.waitForTimeout(1500);

          // --- Click Decline Quote ---
          log.info(`Clicking "Decline Quote" from dropdown`, { jobId });
          const declineClicked = await newPage.evaluate(() => {
            const menuItems = document.querySelectorAll('[data-cy="actions-menu-action"], .actions-menu-action, .menu-item');
            for (const item of menuItems) {
              if (item.textContent?.trim().toLowerCase().includes('decline quote')) {
                (item as HTMLElement).click();
                return true;
              }
            }
            const spans = document.querySelectorAll('span, a, li');
            for (const s of spans) {
              if (s.textContent?.trim() === 'Decline Quote' && (s as HTMLElement).offsetParent !== null) {
                (s as HTMLElement).click();
                return true;
              }
            }
            return false;
          });

          if (!declineClicked) {
            log.warn(`Could not click "Decline Quote" — skipping rest of quotes for job`, { jobId });
            errors.push(`Job ${jobId}: Could not find/click "Decline Quote" menu item`);
            hasMoreOpenQuotes = false;
            break;
          }
          log.info(`"Decline Quote" clicked`, { jobId });

          await newPage.waitForTimeout(2000);

          // --- Fill reason ---
          log.info(`Filling decline reason textarea`, { jobId });
          const reasonFilled = await newPage.evaluate(() => {
            const textarea = document.querySelector('textarea[data-cy="reason"], textarea[name="Reason"], textarea.form-control') as HTMLTextAreaElement;
            if (textarea) {
              textarea.focus();
              textarea.value = 'Briq Denied Quote';
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
              textarea.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          });

          if (!reasonFilled) {
            log.warn(`DOM textarea fill failed — trying locator`, { jobId });
            try {
              await newPage.locator('textarea[data-cy="reason"]').first().fill('Briq Denied Quote');
              log.info(`Textarea filled via locator`, { jobId });
            } catch {
              log.warn(`Locator fill failed — trying AI`, { jobId });
              try {
                await stagehand.act('type "Briq Denied Quote" in the textarea in the decline popup');
                log.info(`Textarea filled via AI`, { jobId });
              } catch (fillErr: any) {
                log.error(`All fill methods failed — closing modal and skipping`, { jobId, error: fillErr.message });
                errors.push(`Job ${jobId}: Failed to fill reason textarea — ${fillErr.message}`);
                await newPage.evaluate(() => {
                  const closeBtn = document.querySelector('button[data-cy="close"], button[data-dismiss="modal"], .modal-close-button');
                  if (closeBtn) (closeBtn as HTMLElement).click();
                });
                hasMoreOpenQuotes = false;
                break;
              }
            }
          } else {
            log.info(`Textarea filled via DOM`, { jobId });
          }

          await newPage.waitForTimeout(500);

          // --- Submit decline ---
          log.info(`Clicking submit / confirm decline button`, { jobId });
          const submitClicked = await newPage.evaluate(() => {
            const btn = document.querySelector('button[data-cy="modal-submit-btn"]') as HTMLElement;
            if (btn) { btn.click(); return true; }
            const modalBtns = document.querySelectorAll('.modal-footer button, .modal button');
            for (const b of modalBtns) {
              if (b.textContent?.trim().toLowerCase().includes('decline')) {
                (b as HTMLElement).click();
                return true;
              }
            }
            return false;
          });

          if (!submitClicked) {
            log.warn(`Could not click submit button — skipping remaining quotes`, { jobId });
            errors.push(`Job ${jobId}: Could not click modal submit button`);
            hasMoreOpenQuotes = false;
            break;
          }

          await newPage.waitForTimeout(3000);

          quotesOnThisJob++;
          quotesDeclined++;
          log.success(`Quote declined`, { jobId, quoteNumber: quotesOnThisJob, totalQuotesDeclinedSoFar: quotesDeclined });
        }

        if (quotesOnThisJob >= MAX_QUOTES_PER_JOB) {
          log.warn(`Hit MAX_QUOTES_PER_JOB safety limit`, { jobId, limit: MAX_QUOTES_PER_JOB });
          errors.push(`Job ${jobId}: Hit safety limit of ${MAX_QUOTES_PER_JOB} quotes per job`);
        }

        await newPage.close();
        log.success(`Job complete`, { jobId, quotesDeclined: quotesOnThisJob });
        jobsProcessed++;

        await page.waitForTimeout(1000);

      } catch (jobErr: any) {
        const errMsg = `Job ${jobId}: Unexpected error — ${jobErr.message}`;
        log.error(errMsg, { jobId, stack: jobErr.stack });
        errors.push(errMsg);
        jobsProcessed++;

        // Clean up extra tabs
        const allPages = stagehand.context.pages();
        while (allPages.length > 1) {
          try { await allPages[allPages.length - 1].close(); } catch {}
          allPages.pop();
        }
      }
    }

    // ==================== DONE ====================
    const resultMsg = `Page ${pageNumber}: Processed ${jobsProcessed} jobs, declined ${quotesDeclined} quotes`;
    log.section("RUN COMPLETE");
    log.success(resultMsg);
    log.summary({ jobsProcessed, quotesDeclined, errors, sessionUrl });

    await stagehand.close();

    return {
      status: "COMPLETED",
      result: resultMsg,
      jobsProcessed,
      quotesDeclined,
      sessionUrl,
      logFilePath: log.logFilePath,
    };

  } catch (error: any) {
    const errMsg = `Fatal error: ${error.message}`;
    log.error(errMsg, { stack: error.stack });
    errors.push(errMsg);
    log.summary({ jobsProcessed, quotesDeclined, errors, sessionUrl });

    try { await stagehand.close(); } catch {}

    return {
      status: "FAILED",
      result: errMsg,
      jobsProcessed,
      quotesDeclined,
      sessionUrl,
      logFilePath: log.logFilePath,
    };
  }
}