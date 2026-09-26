// "Mark as Enrolled" popup -- fires from wherever a contact's status is
// changed to ENROLLED (inline-edit.js, the chat panel's status select, and
// both contact-detail/Inbox-overlay autosave paths). Captures the sale
// details as customFields and PATCHes status to ENROLLED in one request --
// the actual sheet write is a real, editable Flow step ("Enrollment
// Recording (migrated)" in the Flows list) that fires off that status
// change, not something this popup talks to directly. Browser global, same
// convention as call-popup.js.
window.EnrollPopup = (function () {
  // The one source of truth for these lists is calls_sheet_backend.js (which
  // also re-validates against them on save) -- fetched once and cached, so
  // this file never risks drifting from what the server actually accepts.
  let optionsPromise = null;
  function loadOptions() {
    if (!optionsPromise) optionsPromise = fetch("/api/calls-sheet/options").then(r => r.json()).catch(() => ({ programOptions: { online: [], gym: [] }, paymentOptions: [] }));
    return optionsPromise;
  }

  function todayLocalDateInput() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // "4 Month Standard" -> 4, "1Year Standard" -> 12, "Retreat"/"Other"/"NA" -> null
  // (nothing sensible to suggest). Only ever offered as a starting point --
  // End Date stays a plain date input the person can always overwrite.
  function suggestedMonths(program) {
    let m = /(\d+)\s*year/i.exec(program || "");
    if (m) return +m[1] * 12;
    m = /(\d+)\s*month/i.exec(program || "");
    return m ? +m[1] : null;
  }
  function addMonths(dateInputValue, months) {
    if (!dateInputValue || !months) return "";
    const [y, m, d] = dateInputValue.split("-").map(Number);
    const dt = new Date(y, m - 1 + months, d);
    const p = n => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function toast(msg, isError) { if (window.showToast) window.showToast(msg, isError); }

  // "2026-09-22" -> "September 22, 2026" -- the sheet-write flow step just
  // resolves whatever's in these customFields as-is (no date math of its
  // own), so dates need to already be in the sheet's own long-form display
  // style by the time they're written here.
  function longDate(dateInputValue) {
    if (!dateInputValue) return "";
    const d = new Date(dateInputValue + "T00:00:00");
    return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }
  function formatNote(template, notes, enrollmentDateInputValue) {
    if (!notes) return "";
    return template.replace("{date}", longDate(enrollmentDateInputValue) || new Date().toLocaleDateString("en-US")).replace("{notes}", notes);
  }

  let backdropEl = null;
  function close() { backdropEl?.remove(); backdropEl = null; }

  // The contact's status only actually BECOMES Enrolled once this popup's
  // own Save succeeds (see the Save handler below, which PATCHes it there,
  // not before) -- every caller reverts its own optimistic display back to
  // whatever it was BEFORE calling this, so nothing anywhere shows
  // "Enrolled" prematurely. opts.onCommitted() is how the caller finds out
  // it's real and can now show it.
  async function open(contactId, opts = {}) {
    close();
    let contact, sheetOptions;
    try {
      const [contactRes, loadedOptions] = await Promise.all([
        fetch(`/api/contacts/${contactId}`).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
        loadOptions(),
      ]);
      contact = contactRes.contact;
      sheetOptions = loadedOptions;
    } catch { toast("Could not load the contact to record the enrollment", true); return; }
    const { programOptions, paymentOptions, notesTemplate } = sheetOptions;

    const initialSheet = contact.programType === "gym" ? "gym" : "online"; // defaults to online when unset -- both stay one click away
    const today = todayLocalDateInput();

    backdropEl = document.createElement("div");
    // NOT .modal-backdrop -- see crm-design-system.css's own comment on
    // .enroll-modal-backdrop for why (crm-nav.js's global click-outside
    // handler would silently bypass requestClose's confirm gate below).
    backdropEl.className = "enroll-modal-backdrop show";
    backdropEl.innerHTML = `
      <div class="pra-panel modal-box">
        <div class="pra-h2" style="margin-bottom:4px">Record Enrollment</div>
        <div class="pra-muted" style="font-size:.82rem;margin-bottom:16px">${esc([contact.first, contact.last].filter(Boolean).join(" ") || "This contact")} -- updates their row in the CALLS TRACKING sheet.</div>

        <div class="field">
          <label class="pra-label">Sheet</label>
          <div style="display:flex;gap:16px">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer"><input type="radio" name="epSheet" value="online" ${initialSheet === "online" ? "checked" : ""}/> Online</label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer"><input type="radio" name="epSheet" value="gym" ${initialSheet === "gym" ? "checked" : ""}/> Gym</label>
          </div>
        </div>
        <div class="field">
          <label class="pra-label">Program</label>
          <select class="pra-select" id="epProgram"></select>
        </div>
        <div class="field">
          <label class="pra-label">Amount Paid</label>
          <input class="pra-input" id="epAmount" type="number" min="0" step="0.01" placeholder="0.00"/>
        </div>
        <div class="field">
          <label class="pra-label">Payment</label>
          <select class="pra-select" id="epPayment">${paymentOptions.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label class="pra-label">Notes</label>
          <textarea class="pra-input" id="epNotes" rows="2" placeholder="Leave blank to leave the sheet's Notes cell untouched"></textarea>
        </div>
        <div class="field">
          <label class="pra-label">Start Date</label>
          <input class="pra-input" id="epStartDate" type="date" value="${today}"/>
        </div>
        <div class="field">
          <label class="pra-label">End Date</label>
          <input class="pra-input" id="epEndDate" type="date"/>
        </div>
        <div class="field">
          <label class="pra-label">Enrollment Date</label>
          <input class="pra-input" id="epEnrollDate" type="date" value="${today}"/>
        </div>

        <div class="btn-row" style="display:flex;gap:10px;margin-top:16px">
          <button class="pra-btn" id="epSaveBtn" style="flex:1">Save</button>
          <button class="pra-btn pra-btn-ghost" id="epCancelBtn">Cancel</button>
        </div>
        <div class="pra-muted" id="epMsg" style="font-size:.8rem;margin-top:8px;min-height:1em"></div>
      </div>
    `;
    document.body.appendChild(backdropEl);

    const programSel = backdropEl.querySelector("#epProgram");
    const endDateEl = backdropEl.querySelector("#epEndDate");
    let endDateTouched = false;
    endDateEl.addEventListener("input", () => { endDateTouched = true; });
    function renderProgramOptions() {
      const sheet = backdropEl.querySelector('input[name="epSheet"]:checked').value;
      const prev = programSel.value;
      programSel.innerHTML = programOptions[sheet].map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
      if (programOptions[sheet].includes(prev)) programSel.value = prev;
      applyEndDateSuggestion();
    }
    function applyEndDateSuggestion() {
      if (endDateTouched) return;
      const months = suggestedMonths(programSel.value);
      endDateEl.value = months ? addMonths(backdropEl.querySelector("#epStartDate").value || today, months) : "";
    }
    backdropEl.querySelectorAll('input[name="epSheet"]').forEach(r => r.onchange = renderProgramOptions);
    programSel.addEventListener("change", applyEndDateSuggestion);
    backdropEl.querySelector("#epStartDate").addEventListener("change", applyEndDateSuggestion);
    renderProgramOptions();

    // Closing WITHOUT saving means this contact does NOT get enrolled --
    // confirm that's really the intent rather than silently dropping
    // whatever was already filled in, same as any other "you're about to
    // lose this" moment. Backdrop click ("click away") goes through the
    // exact same gate as the Cancel button, not a silent close.
    function requestClose() {
      if (confirm("Are you sure you don't want to enroll this contact?")) close();
    }
    backdropEl.querySelector("#epCancelBtn").onclick = requestClose;
    backdropEl.addEventListener("click", (e) => { if (e.target === backdropEl) requestClose(); });
    backdropEl.querySelector("#epSaveBtn").onclick = async () => {
      const btn = backdropEl.querySelector("#epSaveBtn"), msg = backdropEl.querySelector("#epMsg");
      const notes = backdropEl.querySelector("#epNotes").value.trim();
      const enrollmentDate = backdropEl.querySelector("#epEnrollDate").value;
      // Everything the sheet-write flow step needs, captured as customFields
      // BEFORE the status PATCH below -- that PATCH is what actually fires
      // the flow's status_changed trigger, so these values need to already
      // be on the contact by the time it runs. customFieldsPatch (not
      // customFields) so this never wipes out unrelated custom fields
      // already set on the contact.
      const customFieldsPatch = {
        enrollProgramType: backdropEl.querySelector('input[name="epSheet"]:checked').value,
        enrollProgram: programSel.value,
        enrollAmountPaid: backdropEl.querySelector("#epAmount").value,
        enrollPayment: backdropEl.querySelector("#epPayment").value,
        enrollNotesFormatted: formatNote(notesTemplate, notes, enrollmentDate),
        enrollStartDate: longDate(backdropEl.querySelector("#epStartDate").value),
        enrollEndDate: longDate(endDateEl.value),
        enrollDate: longDate(enrollmentDate),
      };
      btn.disabled = true; msg.textContent = "Saving...";
      try {
        // programType (top-level, not just the customFields copy above) is
        // what the flow's If/Then step actually branches ONLINE vs. GYM on --
        // plenty of older contacts never had this set at all, so without
        // writing it here too, the flow would silently route based on
        // whatever (or nothing) was already there instead of what was just
        // picked in this popup.
        const r = await fetch(`/api/contacts/${contactId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "ENROLLED", programType: customFieldsPatch.enrollProgramType, customFieldsPatch }) });
        if (!r.ok) { btn.disabled = false; msg.textContent = "Could not save"; return; }
        toast("Enrolled -- recording the sale in the sheet now");
        opts.onCommitted && opts.onCommitted();
        close();
      } catch { btn.disabled = false; msg.textContent = "Could not reach the server"; }
    };
  }

  return { open };
})();
