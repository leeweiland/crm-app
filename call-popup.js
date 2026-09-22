// Shared "Call From Personal Phone" / "Call From CRM (and record)" popup --
// opens on a phone-number click from contacts.html, conversation-panel.js
// (inbox.html + contact-detail.html) and contact-detail.html's own dial icon.
// Browser global, same convention as window.ConditionRowBuilder: loaded once,
// used from wherever a phone number is rendered.
window.CallPopup = (function () {
  const VOICE_SDK_URL = "https://sdk.twilio.com/js/voice/releases/2.11.3/twilio.min.js";

  let cfg = null; // { personalPhoneConfigured, voiceConfigured, myIdentity }
  async function loadConfig() {
    if (cfg) return cfg;
    try {
      const r = await fetch("/api/calls/config");
      cfg = r.ok ? await r.json() : { personalPhoneConfigured: false, voiceConfigured: false };
    } catch { cfg = { personalPhoneConfigured: false, voiceConfigured: false }; }
    return cfg;
  }
  function toast(msg, isError) { if (window.showToast) window.showToast(msg, isError); }

  // ── the popup itself ────────────────────────────────────────────────────
  let popupEl = null;
  function closePopup() {
    if (!popupEl) return;
    popupEl.remove(); popupEl = null;
    document.removeEventListener("mousedown", onOutsideClick, true);
  }
  function onOutsideClick(e) { if (popupEl && !popupEl.contains(e.target)) closePopup(); }

  async function open({ contactId, phone, anchorEl, event }) {
    closePopup();
    if (!phone) return;
    const c = await loadConfig();
    popupEl = document.createElement("div");
    popupEl.className = "call-popup";
    // Anchor to the clicked element when we have one (a table cell, a link);
    // otherwise (e.g. a plain click event with no stable element) fall back
    // to the cursor position.
    const rect = anchorEl?.getBoundingClientRect?.();
    const x = rect ? rect.left : (event?.clientX || 0), y = rect ? rect.bottom + 6 : (event?.clientY || 0);
    popupEl.style.left = Math.min(x, window.innerWidth - 230) + "px";
    popupEl.style.top = Math.min(y, window.innerHeight - 90) + "px";
    popupEl.innerHTML = `
      <button type="button" data-call-mode="personal"${c.personalPhoneConfigured ? "" : " disabled title=\"Add your personal phone in Settings > Team Users first\""}>Call From Personal Phone</button>
      <button type="button" data-call-mode="crm"${c.voiceConfigured ? "" : " disabled title=\"An admin needs to click Set Up Voice Calling in Settings > Twilio first\""}>Call From CRM (and record)</button>
    `;
    document.body.appendChild(popupEl);
    popupEl.querySelector('[data-call-mode="personal"]').onclick = () => { closePopup(); callFromPersonalPhone(contactId, phone); };
    popupEl.querySelector('[data-call-mode="crm"]').onclick = () => { closePopup(); callFromCrm(contactId, phone); };
    // Deferred one tick so the click that OPENED the popup doesn't also
    // immediately close it via this same listener.
    setTimeout(() => document.addEventListener("mousedown", onOutsideClick, true), 0);
  }

  // ── "Call From Personal Phone" -- fire and forget; the phone ringing IS the feedback ──
  async function callFromPersonalPhone(contactId, phone) {
    toast("Calling your phone now…");
    try {
      const r = await fetch("/api/calls/click-to-call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactId, phone }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) toast(d.error || "Could not place the call", true);
    } catch { toast("Could not place the call", true); }
  }

  // ── "Call From CRM" -- browser (Twilio Voice SDK) call, recorded ────────
  let sdkLoading = null;
  function loadVoiceSdk() {
    if (window.Twilio?.Device) return Promise.resolve();
    if (sdkLoading) return sdkLoading;
    sdkLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = VOICE_SDK_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load the calling library"));
      document.head.appendChild(s);
    });
    return sdkLoading;
  }

  let device = null, activeCall = null;
  let barEl = null, barTimer = null;
  function ensureBar() {
    if (barEl) return barEl;
    barEl = document.createElement("div");
    barEl.className = "call-bar";
    barEl.innerHTML = `<span class="call-bar-dot"></span><span class="call-bar-status">Connecting…</span><button type="button" class="call-bar-hangup">Hang Up</button>`;
    barEl.querySelector(".call-bar-hangup").onclick = () => activeCall?.disconnect();
    document.body.appendChild(barEl);
    return barEl;
  }
  function setBarStatus(text, ended) {
    const bar = ensureBar();
    bar.querySelector(".call-bar-status").textContent = text;
    bar.classList.toggle("ended", !!ended);
    bar.querySelector(".call-bar-hangup").style.display = ended ? "none" : "";
  }
  function hideBarSoon() {
    clearTimeout(barTimer);
    barTimer = setTimeout(() => { barEl?.remove(); barEl = null; }, 2500);
  }
  let durationTimer = null;
  function startDurationClock() {
    const startedAt = Date.now();
    clearInterval(durationTimer);
    durationTimer = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setBarStatus(`In call · ${String(Math.floor(s / 60)).padStart(1, "0")}:${String(s % 60).padStart(2, "0")}`);
    }, 1000);
  }

  async function callFromCrm(contactId, phone) {
    try {
      await loadVoiceSdk();
      const c = await loadConfig();
      if (!device) {
        const r = await fetch("/api/calls/voice-token", { method: "POST" });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || "Voice calling isn't set up", true); return; }
        device = new window.Twilio.Device(d.token, { logLevel: "error" });
        device.on("error", (e) => { toast("Call error: " + e.message, true); setBarStatus("Call failed", true); hideBarSoon(); });
      }
      setBarStatus("Connecting…");
      const call = await device.connect({ params: { To: phone, ContactId: contactId || "", FromUserId: c.myIdentity || "" } });
      activeCall = call;
      call.on("ringing", () => setBarStatus("Ringing…"));
      call.on("accept", () => startDurationClock());
      call.on("disconnect", () => { clearInterval(durationTimer); setBarStatus("Call ended", true); hideBarSoon(); activeCall = null; });
      call.on("cancel", () => { clearInterval(durationTimer); setBarStatus("Call ended", true); hideBarSoon(); activeCall = null; });
    } catch (e) { toast(e.message || "Could not start the call", true); }
  }

  return { open };
})();
