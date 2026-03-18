// decline-quotes-module.ts
// For each appointment on a filtered page:
//   1. Gets the JOB ID from the table
//   2. Opens job in Quotes tab via direct URL
//   3. Finds all open quotes and declines them
//   4. Moves to next job

import { Stagehand } from "@browserbasehq/stagehand";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

export async function declineQuotesOnPage(input: {
  dateFilter: string;
  pageNumber: number;
}): Promise<{
  status: string;
  result: string;
  jobsProcessed: number;
  quotesDeclined: number;
  sessionUrl: string;
}> {
  const EMAIL = process.env.STRATABLUE_EMAIL || "mcc@stratablue.com";
  const PASSWORD = process.env.STRATABLUE_PASSWORD || "";
  const { dateFilter, pageNumber } = input;

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
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 60000 });
    } catch {
      console.log(`    ⚠️  Page load timeout — continuing`);
    }
    await page.waitForTimeout(waitMs);
  }

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session: ${sessionUrl}`);

    const page = stagehand.context.pages()[0];

    // ==================== STEP 1: LOGIN ====================
    console.log("  → Login");
    await safeGoto(page, "https://misterquik.sera.tech/admins/login", 3000);
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(1000);

    const loginSelectors = ['input[type="submit"]', 'button[type="submit"]', 'button.btn-primary'];
    for (const sel of loginSelectors) {
      try {
        const vis = await page.locator(sel).first().isVisible();
        if (vis) { await page.locator(sel).first().click(); break; }
      } catch {}
    }

    await page.waitForTimeout(5000);
    if (page.url().includes("/login")) {
      throw new Error("Login failed — still on login page");
    }
    console.log(`    ✅ Logged in`);

    // ==================== STEP 2: GO TO FILTERED APPOINTMENTS ====================
    const appointmentsUrl = `https://misterquik.sera.tech/reports/appointments?jobs-table_scheduled_time=${encodeURIComponent(dateFilter)}&jobs-table_status=completed`;
    console.log(`  → Navigating to appointments`);
    await safeGoto(page, appointmentsUrl, 15000);
    console.log(`    ✅ On: ${page.url()}`);

    // ==================== STEP 3: NAVIGATE TO REQUESTED PAGE ====================
    if (pageNumber > 1) {
      console.log(`  → Navigating to page ${pageNumber}`);
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
        await stagehand.act(`click on page number ${pageNumber} in the pagination at the bottom`);
      }
      await page.waitForTimeout(5000);
      console.log(`    ✅ On page ${pageNumber}`);
    }

    // ==================== STEP 4: COLLECT JOB IDS FROM TABLE ====================
    console.log("  → Collecting JOB IDs from table");

    // The table has columns: APPOINTMENT, SCHEDULED FOR, CREATED AT, CREATED SOURCE, CREATED BY, JOB, TAGS, CUSTOMER, ACTION
    // We need one JOB ID per row. The JOB column has a plain number (no link), but the APPOINTMENT column
    // has a link like /jobs/{jobId}?appointment_id={apptId}. We extract the jobId from that.
    const jobIds: string[] = await page.evaluate(() => {
      const ids: string[] = [];
      const rows = document.querySelectorAll('table tbody tr, tbody.table-data tr');
      for (const row of rows) {
        // Strategy: find the first <a> with href containing /jobs/ and appointment_id
        // This is the APPOINTMENT column link which contains the JOB ID
        const firstJobLink = row.querySelector('a[href*="/jobs/"]');
        if (firstJobLink) {
          const href = firstJobLink.getAttribute('href') || '';
          const match = href.match(/\/jobs\/(\d+)/);
          if (match) {
            ids.push(match[1]);
            continue; // one per row, move to next row
          }
        }
        // Fallback: look for a cell that contains just a number (the JOB column)
        const cells = row.querySelectorAll('td');
        for (const cell of cells) {
          const text = cell.textContent?.trim() || '';
          // JOB IDs are 7-digit numbers with no other text in the cell
          if (/^\d{6,}$/.test(text)) {
            ids.push(text);
            break; // one per row
          }
        }
      }
      return ids;
    });

    console.log(`    ℹ️  Found ${jobIds.length} jobs: ${jobIds.slice(0, 10).join(", ")}${jobIds.length > 10 ? "..." : ""}`);

    if (jobIds.length === 0) {
      // Fallback: extract from the APPOINTMENT column links
      console.log("    ⚠️  No job IDs found via primary method, trying fallback...");
      const appointmentIds: string[] = await page.evaluate(() => {
        const ids: string[] = [];
        const rows = document.querySelectorAll('table tbody tr, tbody.table-data tr');
        for (const row of rows) {
          const link = row.querySelector('a[href*="/jobs/"]');
          if (link) {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/jobs\/(\d+)/);
            if (match) { ids.push(match[1]); continue; }
          }
        }
        return ids;
      });

      if (appointmentIds.length === 0) {
        await stagehand.close();
        return {
          status: "COMPLETED",
          result: `Page ${pageNumber}: No jobs found`,
          jobsProcessed: 0,
          quotesDeclined: 0,
          sessionUrl,
        };
      }
      jobIds.push(...appointmentIds);
      console.log(`    ℹ️  Found ${jobIds.length} via fallback: ${jobIds.slice(0, 10).join(", ")}`);
    }

    // ==================== STEP 5: PROCESS EACH JOB ====================
    for (const jobId of jobIds) {
      console.log(`\n  → Processing job ${jobId}`);

      try {
        // Open job Quotes tab directly in a new tab
        const jobQuotesUrl = `https://misterquik.sera.tech/jobs/${jobId}?tab=jp_Quotes`;

        // Open new tab
        const newPage = await stagehand.context.newPage();
        try {
          await newPage.goto(jobQuotesUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        } catch {
          console.log(`    ⚠️  Job page load timeout — continuing`);
        }
        await newPage.waitForTimeout(5000);

        console.log(`    ✅ Opened Quotes tab for job ${jobId}`);

        // Check if Open section exists and has quotes
        let hasMoreOpenQuotes = true;
        let quotesOnThisJob = 0;
        const MAX_QUOTES_PER_JOB = 20; // safety limit

        while (hasMoreOpenQuotes && quotesOnThisJob < MAX_QUOTES_PER_JOB) {
          // Find open quotes by looking for the "Open" section header and quote cards under it
          const openQuoteInfo = await newPage.evaluate(() => {
            // Find the "Open" group header
            const headers = document.querySelectorAll('.group-header, [class*="quote-group"]');
            let openSection: Element | null = null;
            for (const h of headers) {
              if (h.textContent?.trim().toLowerCase().startsWith('open')) {
                openSection = h.closest('.quote-group') || h.parentElement;
                break;
              }
            }

            if (!openSection) {
              // Try finding by text content
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

            // Count quote cards with three-dot menus in the Open section
            const actionTriggers = openSection.querySelectorAll('[data-cy="action-trigger-icon"], .action-trigger, .fa-ellipsis-v');
            return { hasOpen: actionTriggers.length > 0, count: actionTriggers.length };
          });

          if (!openQuoteInfo.hasOpen) {
            if (quotesOnThisJob === 0) {
              console.log(`    ℹ️  No open quotes on job ${jobId}`);
            }
            hasMoreOpenQuotes = false;
            break;
          }

          console.log(`    ℹ️  Found ${openQuoteInfo.count} open quote(s)`);

          // Click the three dots on the FIRST open quote
          console.log(`    → Clicking three dots on open quote`);
          const dotsClicked = await newPage.evaluate(() => {
            // Find the Open section
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

            // Find first action trigger icon in the Open section
            const trigger = openSection.querySelector('[data-cy="action-trigger-icon"], .action-trigger, .fa-ellipsis-v, i.fa-ellipsis-v');
            if (trigger) {
              (trigger as HTMLElement).click();
              return true;
            }

            // Fallback: find the wrapper and click it
            const wrapper = openSection.querySelector('.actions-menu-wrapper, .action-menu-cont');
            if (wrapper) {
              (wrapper as HTMLElement).click();
              return true;
            }

            return false;
          });

          if (!dotsClicked) {
            console.log(`    ⚠️  Could not click three dots via DOM, trying AI...`);
            try {
              await stagehand.act("click the three dots menu icon next to the first quote under the Open section");
            } catch {
              console.log(`    ⚠️  AI also failed to click dots — skipping job`);
              hasMoreOpenQuotes = false;
              break;
            }
          }

          await newPage.waitForTimeout(1500);

          // Click "Decline Quote" from the dropdown menu
          console.log(`    → Clicking Decline Quote option`);
          const declineClicked = await newPage.evaluate(() => {
            // Look for menu items with data-cy="actions-menu-action"
            const menuItems = document.querySelectorAll('[data-cy="actions-menu-action"], .actions-menu-action, .menu-item');
            for (const item of menuItems) {
              if (item.textContent?.trim().toLowerCase().includes('decline quote')) {
                (item as HTMLElement).click();
                return true;
              }
            }
            // Fallback: look for any visible span/element with "Decline Quote"
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
            console.log(`    ⚠️  Could not click Decline Quote — skipping`);
            hasMoreOpenQuotes = false;
            break;
          }

          await newPage.waitForTimeout(2000);

          // Fill the reason textarea in the modal
          console.log(`    → Filling decline reason`);
          const reasonFilled = await newPage.evaluate(() => {
            // Target the exact textarea: data-cy="reason"
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
            console.log(`    ⚠️  Could not fill reason via DOM, trying locator...`);
            try {
              await newPage.locator('textarea[data-cy="reason"]').first().fill('Briq Denied Quote');
            } catch {
              console.log(`    ⚠️  Locator also failed — trying AI`);
              try {
                await stagehand.act('type "Briq Denied Quote" in the textarea in the decline popup');
              } catch {
                console.log(`    ⚠️  All fill methods failed — skipping`);
                // Try to close the modal
                await newPage.evaluate(() => {
                  const closeBtn = document.querySelector('button[data-cy="close"], button[data-dismiss="modal"], .modal-close-button');
                  if (closeBtn) (closeBtn as HTMLElement).click();
                });
                hasMoreOpenQuotes = false;
                break;
              }
            }
          }

          await newPage.waitForTimeout(500);

          // Click the Decline Quote submit button
          console.log(`    → Confirming decline`);
          const submitClicked = await newPage.evaluate(() => {
            // Target: button with data-cy="modal-submit-btn"
            const btn = document.querySelector('button[data-cy="modal-submit-btn"]') as HTMLElement;
            if (btn) { btn.click(); return true; }

            // Fallback: any button in the modal footer with "Decline" text
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
            console.log(`    ⚠️  Could not click submit button — skipping`);
            hasMoreOpenQuotes = false;
            break;
          }

          await newPage.waitForTimeout(3000);

          quotesOnThisJob++;
          quotesDeclined++;
          console.log(`    ✅ Declined quote ${quotesOnThisJob} on job ${jobId}`);
        }

        // Close the job tab and go back to appointments tab
        await newPage.close();
        console.log(`  ✅ Job ${jobId} done — ${quotesOnThisJob} quotes declined`);
        jobsProcessed++;

        // Small delay between jobs
        await page.waitForTimeout(1000);

      } catch (e: any) {
        console.log(`  ⚠️  Error processing job ${jobId}: ${e.message}`);
        jobsProcessed++;
        // Try to close any extra tabs
        const allPages = stagehand.context.pages();
        while (allPages.length > 1) {
          try { await allPages[allPages.length - 1].close(); } catch {}
          allPages.pop();
        }
      }
    }

    // ==================== DONE ====================
    const resultMsg = `Page ${pageNumber}: Processed ${jobsProcessed} jobs, declined ${quotesDeclined} quotes`;
    console.log(`\n🎉 ${resultMsg}`);

    await stagehand.close();

    return {
      status: "COMPLETED",
      result: resultMsg,
      jobsProcessed,
      quotesDeclined,
      sessionUrl,
    };
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    try { await stagehand.close(); } catch {}
    return {
      status: "FAILED",
      result: `Error: ${error.message}`,
      jobsProcessed,
      quotesDeclined,
      sessionUrl,
    };
  }
}