import { clientIp, lookupIpLocation } from "./tracking_backend.js";

// Country-aware phone capture. Forms/bookings have always stored a phone
// exactly as typed -- fine for a US number ("907 555 0100"), but a UK visitor
// typing their own national format ("07956 650003") left staff and every
// downstream tool (Calendar description, notification email, Sheet, SMS) with
// a number that can't be dialed from outside the UK, and sms_backend.js's
// normalizePhoneToE164 then turned it into "+07956650003".
//
// Deliberately conservative: a US/Canada-looking number is NEVER rewritten
// (that's the existing behavior every US contact and the last-10-digit
// matching already relies on), and a number is only rewritten when there's
// real evidence of its country -- the request's IP country, or (for a
// national-format number with a leading 0, which can't be a US number) the
// invitee's chosen timezone.

// ISO 3166 alpha-2 -> country calling code.
const DIAL = {
  AD:"376",AE:"971",AF:"93",AL:"355",AM:"374",AO:"244",AR:"54",AT:"43",AU:"61",AZ:"994",
  BA:"387",BD:"880",BE:"32",BF:"226",BG:"359",BH:"973",BI:"257",BJ:"229",BN:"673",BO:"591",BR:"55",BT:"975",BW:"267",BY:"375",BZ:"501",
  CD:"243",CH:"41",CI:"225",CL:"56",CM:"237",CN:"86",CO:"57",CR:"506",CU:"53",CY:"357",CZ:"420",
  DE:"49",DK:"45",DZ:"213",EC:"593",EE:"372",EG:"20",ES:"34",ET:"251",FI:"358",FJ:"679",FR:"33",
  GA:"241",GB:"44",GE:"995",GH:"233",GR:"30",GT:"502",HK:"852",HN:"504",HR:"385",HU:"36",
  ID:"62",IE:"353",IL:"972",IN:"91",IQ:"964",IR:"98",IS:"354",IT:"39",JO:"962",JP:"81",
  KE:"254",KG:"996",KH:"855",KR:"82",KW:"965",KZ:"7",LA:"856",LB:"961",LI:"423",LK:"94",LT:"370",LU:"352",LV:"371",LY:"218",
  MA:"212",MC:"377",MD:"373",ME:"382",MG:"261",MK:"389",ML:"223",MM:"95",MN:"976",MO:"853",MT:"356",MU:"230",MV:"960",MX:"52",MY:"60",MZ:"258",
  NA:"264",NG:"234",NI:"505",NL:"31",NO:"47",NP:"977",NZ:"64",OM:"968",PA:"507",PE:"51",PH:"63",PK:"92",PL:"48",PT:"351",PY:"595",
  QA:"974",RO:"40",RS:"381",RU:"7",RW:"250",SA:"966",SE:"46",SG:"65",SI:"386",SK:"421",SN:"221",SV:"503",SY:"963",
  TH:"66",TN:"216",TR:"90",TW:"886",TZ:"255",UA:"380",UG:"256",UY:"598",UZ:"998",VE:"58",VN:"84",
  ZA:"27",ZM:"260",ZW:"263",
};
// Countries on the +1 plan: US-style numbers are left exactly as entered.
const NANP = new Set(["US","CA","PR","GU","VI","AS","MP","BS","BB","BM","JM","DO","TT","AG","AI","DM","GD","KN","LC","VC","KY","TC","VG","SX","AG"]);

// Timezone -> country, only for the countries whose visitors are common
// here. Used solely as a fallback for a leading-0 national number when the
// IP itself says US/CA/unknown (VPN, mobile carrier gateway).
const TZ_COUNTRY = {
  "Europe/London":"GB","Europe/Dublin":"IE","Europe/Paris":"FR","Europe/Berlin":"DE","Europe/Madrid":"ES","Europe/Rome":"IT",
  "Europe/Amsterdam":"NL","Europe/Brussels":"BE","Europe/Zurich":"CH","Europe/Vienna":"AT","Europe/Stockholm":"SE","Europe/Oslo":"NO",
  "Europe/Copenhagen":"DK","Europe/Helsinki":"FI","Europe/Lisbon":"PT","Europe/Warsaw":"PL","Europe/Prague":"CZ","Europe/Athens":"GR",
  "Europe/Budapest":"HU","Europe/Bucharest":"RO","Europe/Istanbul":"TR","Europe/Kiev":"UA","Europe/Kyiv":"UA",
  "Australia/Sydney":"AU","Australia/Melbourne":"AU","Australia/Brisbane":"AU","Australia/Perth":"AU","Australia/Adelaide":"AU","Australia/Hobart":"AU","Australia/Darwin":"AU",
  "Pacific/Auckland":"NZ","Asia/Singapore":"SG","Asia/Hong_Kong":"HK","Asia/Tokyo":"JP","Asia/Seoul":"KR","Asia/Kolkata":"IN","Asia/Calcutta":"IN",
  "Asia/Dubai":"AE","Asia/Manila":"PH","Asia/Jakarta":"ID","Asia/Bangkok":"TH","Asia/Kuala_Lumpur":"MY","Asia/Jerusalem":"IL",
  "Africa/Johannesburg":"ZA","Africa/Lagos":"NG","Africa/Nairobi":"KE","Africa/Cairo":"EG",
  "America/Mexico_City":"MX","America/Sao_Paulo":"BR","America/Argentina/Buenos_Aires":"AR","America/Bogota":"CO","America/Santiago":"CL",
};

export function countryFromTimezone(tz) {
  return TZ_COUNTRY[String(tz || "")] || "";
}

// ip-api's country NAME (what page-visit records store) -> ISO code, for the
// handful of countries this business's leads actually come from.
const NAME_TO_ISO = {
  "united kingdom":"GB","ireland":"IE","australia":"AU","new zealand":"NZ","germany":"DE","france":"FR","spain":"ES","italy":"IT",
  "netherlands":"NL","belgium":"BE","switzerland":"CH","austria":"AT","sweden":"SE","norway":"NO","denmark":"DK","finland":"FI",
  "portugal":"PT","poland":"PL","czechia":"CZ","czech republic":"CZ","cyprus":"CY","greece":"GR","lithuania":"LT","latvia":"LV",
  "estonia":"EE","south africa":"ZA","singapore":"SG","india":"IN","united arab emirates":"AE","israel":"IL","mexico":"MX","brazil":"BR",
};
export function countryFromName(name) {
  return NAME_TO_ISO[String(name || "").trim().toLowerCase()] || "";
}

// National-format (leading 0) numbers whose SHAPE alone names the country --
// checked before IP/timezone because a UK sim on a VPN, or an Australian in
// London, still types a number that can only be theirs. Anything not
// unambiguous returns "" and falls through to the IP/timezone evidence.
export function inferCountryFromFormat(digits) {
  if (/^07\d{9}$/.test(digits)) return "GB";                       // UK mobile (also Jersey/Guernsey/Isle of Man, all +44)
  if (/^0[23]\d{9}$/.test(digits)) return "GB";                    // UK 02x / 03xx
  if (/^01\d{9}$/.test(digits) && !/^01(5[1-9]|6[0-3]|7\d)/.test(digits)) return "GB"; // UK 01xxx, minus prefixes Germany also uses for mobiles
  if (/^01[567]\d{9}$/.test(digits)) return "DE";                  // 12 digits: German mobile (a UK number is never longer than 11)
  if (/^04[0-4]\d{7}$/.test(digits)) return "AU";                  // AU mobile (04[5-9] overlaps Belgium's)
  return "";
}

// raw phone + { countryCode (ISO alpha-2 from the request IP), timezone }.
// Returns the phone unchanged unless it can be confidently made
// internationally dialable ("+" + country code + national number).
export function normalizePhoneForCapture(raw, { countryCode, timezone } = {}) {
  const input = String(raw || "").trim();
  if (!input) return "";
  // "+44 (0) 7956 650003" -- the "(0)" is a trunk digit that must not survive.
  const cleaned = input.replace(/\(0\)/g, "");
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 6) return input;

  if (cleaned.startsWith("+")) return "+" + digits;
  if (cleaned.startsWith("00") && digits.length >= 10) return "+" + digits.slice(2);

  // US/Canada-shaped (10 digits, or 11 with a leading 1) -- never touched.
  if (/^1?[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return input;

  const nationalWithZero = digits.startsWith("0");
  const ipCc = String(countryCode || "").toUpperCase();
  // A leading 0 can't be a US number, so its own shape and the timezone are
  // safe evidence too -- in that order, ahead of the IP (see inferCountryFromFormat).
  let cc = nationalWithZero ? inferCountryFromFormat(digits) : "";
  if (!cc && ipCc && !NANP.has(ipCc) && DIAL[ipCc]) cc = ipCc;
  if (!cc && nationalWithZero) cc = countryFromTimezone(timezone);
  if (!cc) return input;

  const dial = DIAL[cc];
  if (!dial) return input;
  let national = digits;
  if (national.startsWith(dial) && national.length - dial.length >= 7 && !nationalWithZero) return "+" + national;
  // Trunk prefix: "0" nearly everywhere (Italy keeps it as part of the
  // number), "8" in Russia/Kazakhstan.
  if (dial === "7" && national.length === 11 && national.startsWith("8")) national = national.slice(1);
  else if (nationalWithZero && cc !== "IT") national = national.slice(1);
  if (national.length < 6 || national.length > 12) return input;
  return "+" + dial + national;
}

// Request-time wrapper: only pays for the IP lookup when the phone is still
// un-normalized after the free checks (shape + timezone) and isn't already a
// US-shaped or "+"-prefixed number -- the common US submission never waits on it.
export async function normalizePhoneForRequest(req, raw, timezone) {
  const first = normalizePhoneForCapture(raw, { timezone });
  const input = String(raw || "").trim();
  if (!input || first !== input) return first;
  const digits = input.replace(/\(0\)/g, "").replace(/\D/g, "");
  if (input.startsWith("+") || digits.length < 6 || /^1?[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return first;
  const location = await lookupIpLocation(clientIp(req)).catch(() => null);
  return normalizePhoneForCapture(raw, { countryCode: location?.countryCode, timezone });
}
