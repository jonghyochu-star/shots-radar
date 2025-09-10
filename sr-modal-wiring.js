/* sr-modal-wiring.js
 * Minimal patch: re-connect channel-name clicks to the existing channel modal.
 * - Does NOT change your UI markup or styles.
 * - Tries to find an existing modal (#channelModal / #chModal / #ytChModal / .channel-modal).
 * - Populates fields (name, id, url) using many common selectors from older versions.
 * - If no modal found, leaves default behavior.
 */
(function () {
  // Helper: select one among multiple selectors
  function $(root, sels) {
    for (const s of sels.split(',')) {
      const el = root.querySelector(s.trim());
      if (el) return el;
    }
    return null;
  }
  // Copy to clipboard
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch (e2) {
        return false;
      }
    }
  }
  // Try to find the table/list container once
  const listRoot = document.querySelector(
    '#videoTable, #tblVideos, .video-table, .video-list, #list, #table, table'
  ) || document;
  // Event delegation (capture) to beat old handlers that used alert()
  document.addEventListener('click', function (ev) {
    const target = ev.target;
    if (!target) return;
    // Find the nearest link-ish element
    const link = target.closest('a, .ch-link, [data-ch-link]');
    if (!link) return;
    // Heuristics: is this a channel link?
    let isChannel = false;
    const href = (link.getAttribute('href') || '').trim();
    if (link.hasAttribute('data-ch-link') || link.classList.contains('ch-link')) isChannel = true;
    if (/\/channel\/UC[0-9A-Za-z_-]{16,}/.test(href)) isChannel = true;
    if (/^https?:\/\/(www\.)?youtube\.com\/@/.test(href)) isChannel = true;
    // If not obviously channel, check table context (Channel column)
    if (!isChannel) {
      const td = link.closest('td, .td-channel, [data-col="channel"]');
      if (td) isChannel = true;
    }
    if (!isChannel) return; // Not our target; let it pass
    
    // Prevent the old alert or navigation
    ev.preventDefault();
    ev.stopImmediatePropagation();
    
    // Extract name / id / url
    const name = (link.textContent || '').trim();
    let url = href || '';
    // Build a URL if it's missing but we have ID stored
    let chId = link.getAttribute('data-channel-id') || '';
    if (!chId) {
      const m = url.match(/\/channel\/(UC[0-9A-Za-z_-]{16,32})/);
      if (m) chId = m[1];
    }
    if (!chId) {
      // Try row level dataset or text fallback
      const tr = link.closest('tr');
      if (tr) {
        chId = tr.getAttribute('data-channel-id') || '';
        if (!chId) {
          const uc = (tr.textContent || '').match(/(UC[0-9A-Za-z_-]{16,32})/);
          if (uc) chId = uc[1];
        }
      }
    }
    if (!url && chId) {
      url = 'https://www.youtube.com/channel/' + chId;
    }
    
    // Find existing modal (we do NOT inject new UI)
    const modal = document.querySelector('#channelModal, #chModal, #ytChModal, .channel-modal, [data-modal="channel"]');
    if (!modal) {
      // No modal present; fallback to the old behavior to avoid breaking UX.
      // (You can remove this alert if you never want a fallback.)
      alert('채널: ' + name + '\nID: ' + (chId || '(ID 미탐지)'));
      return;
    }
    // Populate fields using common selectors used in previous versions
    const nameEl = $(modal, '#ch_name, .ch-name, [data-field="name"], .field-name') || $(modal, 'input[name="ch_name"], input[data-field="name"]');
    const idEl   = $(modal, '#ch_id, .ch-id, [data-field="id"], .field-id') || $(modal, 'input[name="ch_id"], input[data-field="id"]');
    const urlEl  = $(modal, '#ch_url, .ch-url, [data-field="url"], .field-url') || $(modal, 'input[name="ch_url"], input[data-field="url"]');
    
    if (nameEl) {
      if ('value' in nameEl) nameEl.value = name;
      else nameEl.textContent = name;
    }
    if (idEl) {
      if ('value' in idEl) idEl.value = chId || '';
      else idEl.textContent = chId || '';
    }
    if (urlEl) {
      if ('value' in urlEl) urlEl.value = url || '';
      else urlEl.textContent = url || '';
      if (urlEl.tagName === 'A' && url) {
        urlEl.href = url;
      }
    }
    // Wire copy button if present
    const btnCopy = $(modal, '.btn-copy, [data-action="copy"], #btnCopyId');
    if (btnCopy) {
      btnCopy.onclick = async function () {
        const ok = await copy(chId || '');
        if (!ok) alert('복사 실패');
      };
    }
    // Wire "append to 경쟁 채널" if present
    const btnAppend = $(modal, '.btn-append-rivals, [data-action="append-rivals"], #btnAppendRivals');
    if (btnAppend) {
      btnAppend.onclick = function () {
        const rivalInput = document.querySelector('input[name*="rival" i], input[placeholder*="경쟁"], input[name*="comp" i], input[id*="경쟁"], input[name*="경쟁"]');
        if (rivalInput) {
          const cur = (rivalInput.value || '').trim();
          const token = chId || name;
          if (token) {
            rivalInput.value = cur ? (cur + ',' + token) : token;
            rivalInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      };
    }
    // Show modal (Bootstrap / native dialog / fallback)
    try {
      if (window.bootstrap && window.bootstrap.Modal) {
        const inst = bootstrap.Modal.getOrCreateInstance(modal);
        inst.show();
      } else if (typeof modal.showModal === 'function') {
        modal.showModal();
      } else {
        modal.classList.remove('hidden');
        modal.style.display = 'block';
      }
    } catch (e) {
      // As last resort
      alert('채널: ' + name + '\nID: ' + (chId || '(ID 미탐지)'));
    }
  }, true);

  // Paint channel links as clickable without touching markup
  function repaintClickable() {
    const sels = [
      'td a[href*="/channel/"]',
      'td a[href^="https://www.youtube.com/@"]',
      'a.ch-link,[data-ch-link]',
      '.td-channel a'
    ];
    document.querySelectorAll(sels.join(',')).forEach(a => {
      a.classList.add('sr-channel-link');
      a.style.textDecoration = 'underline dotted';
      a.style.cursor = 'pointer';
    });
  }
  repaintClickable();
  // Repaint after dynamic updates
  const mo = new MutationObserver(() => repaintClickable());
  mo.observe(document.body, { childList: true, subtree: true });
})();