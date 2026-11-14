// Every column the extension can show. m = one row's numbers from the CRM
// (/api/reporting/ext-columns): spend/impressions/clicks/linkClicks from the
// ad platform; leads, emailsOnline, emailsGym, bookings, applications, calls,
// enrollments, revenue, cash, customers from the CRM. drill = which contact
// list a click on the number opens.
const div = (a, b) => (b ? a / b : null);
window.PRA_COLUMNS = [
  { k: "leads", label: "Leads", tip: "Opt-ins (ONLINE EMAIL + GYM EMAIL)", fmt: "n", get: m => m.leads, drill: "leads" },
  { k: "emailsOnline", label: "Online opt-ins", fmt: "n", get: m => m.emailsOnline, drill: "leads" },
  { k: "emailsGym", label: "Gym opt-ins", fmt: "n", get: m => m.emailsGym, drill: "leads" },
  { k: "cpl", label: "Cost / lead", fmt: "$", get: m => div(m.spend, m.leads) },
  { k: "calls", label: "Calls", tip: "Online bookings + gym applications", fmt: "n", get: m => m.calls, drill: "calls" },
  { k: "bookings", label: "Online bookings", fmt: "n", get: m => m.bookings, drill: "calls" },
  { k: "applications", label: "Gym apps", fmt: "n", get: m => m.applications, drill: "calls" },
  { k: "cpcall", label: "Cost / call", fmt: "$", get: m => div(m.spend, m.calls) },
  { k: "enrollments", label: "Enrollments", tip: "CALLS TRACKING rows marked Enrolled, by Date Of Enrollment", fmt: "n", get: m => m.enrollments, drill: "enrollments" },
  { k: "cpe", label: "Cost / enroll", fmt: "$", get: m => div(m.spend, m.enrollments) },
  { k: "revenue", label: "Revenue", tip: "Amount Paid on those enrollments (CALLS TRACKING)", fmt: "$", get: m => m.revenue, drill: "enrollments" },
  { k: "cash", label: "Cash collected", tip: "Processor payments in range (Financials)", fmt: "$", get: m => m.cash, drill: "cash" },
  { k: "customers", label: "Paying customers", fmt: "n", get: m => m.customers, drill: "cash" },
  { k: "roas", label: "ROAS", tip: "Revenue / spend", fmt: "x", get: m => div(m.revenue, m.spend) },
  { k: "cashRoas", label: "Cash ROAS", fmt: "x", get: m => div(m.cash, m.spend) },
  { k: "profit", label: "Profit", tip: "Revenue - spend", fmt: "$", get: m => m.revenue - m.spend },
  { k: "roi", label: "ROI", tip: "(Revenue - spend) / spend", fmt: "%", get: m => div(m.revenue - m.spend, m.spend) },
  { k: "leadToCall", label: "Lead → call", fmt: "%", get: m => div(m.calls, m.leads) },
  { k: "callToClose", label: "Close rate", tip: "Enrollments / calls", fmt: "%", get: m => div(m.enrollments, m.calls) },
  { k: "clickToLead", label: "Click → lead", tip: "Leads / link clicks", fmt: "%", get: m => div(m.leads, m.linkClicks) },
  { k: "spend", label: "Spend", tip: "Spend as the CRM pulled it from the platform", fmt: "$", get: m => m.spend },
];
window.PRA_DEFAULT_COLS = ["leads", "cpl", "calls", "cpcall", "enrollments", "revenue", "roas"];
window.PRA_FMT = (fmt, v) => {
  if (v == null || !Number.isFinite(v)) return "—";
  if (fmt === "$") return (v < 0 ? "-$" : "$") + (v === 0 ? "0" : Math.abs(v) >= 1000 ? Math.round(Math.abs(v)).toLocaleString("en-US") : Math.abs(v).toFixed(2));
  if (fmt === "x") return v.toFixed(2) + "x";
  if (fmt === "%") return (v * 100).toFixed(v < 0.1 ? 1 : 0) + "%";
  return Math.round(v).toLocaleString("en-US");
};
