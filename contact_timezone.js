// Server-side twin of contact-time.js (a plain browser global script, not an
// ES module, so it can't be imported here directly) -- infers a contact's
// timezone from their phone number's NANP area code (US/Canada/Caribbean) or
// country calling code otherwise. Kept as a separate copy rather than a
// shared import: contact-time.js also does DOM rendering (chipHtml/mount/
// refresh) that has no business running in Node, and this file only needs
// the pure lookup. Keep the two tables in sync if either changes.
//
// It's an estimate, not a fact -- see contact-time.js's own comment for why
// (an area code says where a number was issued, not where someone lives).

const NANP_BY_ZONE = {
  "America/New_York":
    "203 475 860 959 302 202 771 239 305 321 352 386 407 561 645 656 689 727 754 772 786 813 863 904 941 954 " +
    "229 404 470 478 678 706 762 770 912 943 260 317 463 574 765 812 502 606 859 339 351 413 508 617 774 781 857 978 " +
    "240 301 410 443 667 207 231 248 269 313 517 586 616 679 734 810 906 947 989 603 " +
    "201 551 609 640 732 848 856 862 908 973 212 315 332 347 363 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934 " +
    "252 336 704 743 828 910 919 980 984 216 220 234 326 330 380 419 440 513 567 614 740 937 " +
    "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878 401 803 839 843 854 864 423 865 802 " +
    "276 434 540 571 686 703 757 804 948 304 681",
  "America/Toronto": "226 249 289 343 365 382 416 437 519 548 613 647 683 705 742 807 905 354 367 418 438 450 514 579 581 819 873",
  "America/Chicago":
    "205 251 256 334 659 938 479 501 870 448 850 217 224 309 312 331 464 618 630 708 773 779 815 847 872 219 " +
    "319 515 563 641 712 316 620 785 913 270 364 225 318 337 504 985 218 320 507 612 651 763 952 228 601 662 769 " +
    "314 417 557 573 636 660 816 308 402 531 701 405 539 572 580 918 605 615 629 731 901 931 " +
    "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979 " +
    "262 274 414 534 608 715 920",
  "America/Winnipeg": "204 431",
  "America/Regina": "306 474 639",
  "America/Denver": "303 719 720 970 983 406 505 575 385 435 801 307 915",
  "America/Boise": "208 986",
  "America/Phoenix": "480 520 602 623 928",
  "America/Edmonton": "368 403 587 780 825",
  "America/Los_Angeles":
    "209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 " +
    "820 831 840 858 909 916 925 935 949 951 702 725 775 458 503 541 971 206 253 360 425 509 564",
  "America/Vancouver": "236 250 604 672 778",
  "America/Anchorage": "907",
  "Pacific/Honolulu": "808",
  "America/Puerto_Rico": "787 939",
  "America/St_Thomas": "340",
  "America/Halifax": "902 782",
  "America/Moncton": "506",
  "America/St_Johns": "709 879",
  "Pacific/Guam": "671",
  "Pacific/Saipan": "670",
  "Pacific/Pago_Pago": "684",
  "America/Nassau": "242",
  "America/Barbados": "246",
  "America/Anguilla": "264",
  "America/Antigua": "268",
  "America/Tortola": "284",
  "America/Cayman": "345",
  "Atlantic/Bermuda": "441",
  "America/Grenada": "473",
  "America/Grand_Turk": "649",
  "America/Montserrat": "664",
  "America/Lower_Princes": "721",
  "America/St_Lucia": "758",
  "America/Dominica": "767",
  "America/St_Vincent": "784",
  "America/Santo_Domingo": "809 829 849",
  "America/Port_of_Spain": "868",
  "America/St_Kitts": "869",
  "America/Jamaica": "876 658",
};
const AREA = {};
for (const [zone, codes] of Object.entries(NANP_BY_ZONE)) for (const c of codes.split(" ")) if (c) AREA[c] = zone;

const CC = {
  20: ["Africa/Cairo"], 27: ["Africa/Johannesburg"], 30: ["Europe/Athens"], 31: ["Europe/Amsterdam"],
  32: ["Europe/Brussels"], 33: ["Europe/Paris"], 34: ["Europe/Madrid"], 36: ["Europe/Budapest"],
  39: ["Europe/Rome"], 40: ["Europe/Bucharest"], 41: ["Europe/Zurich"], 43: ["Europe/Vienna"],
  44: ["Europe/London"], 45: ["Europe/Copenhagen"], 46: ["Europe/Stockholm"], 47: ["Europe/Oslo"],
  48: ["Europe/Warsaw"], 49: ["Europe/Berlin"],
  51: ["America/Lima"], 52: ["America/Mexico_City", 1], 53: ["America/Havana"],
  54: ["America/Argentina/Buenos_Aires"], 55: ["America/Sao_Paulo", 1], 56: ["America/Santiago"],
  57: ["America/Bogota"], 58: ["America/Caracas"],
  60: ["Asia/Kuala_Lumpur"], 61: ["Australia/Sydney", 1], 62: ["Asia/Jakarta", 1], 63: ["Asia/Manila"],
  64: ["Pacific/Auckland"], 65: ["Asia/Singapore"], 66: ["Asia/Bangkok"],
  81: ["Asia/Tokyo"], 82: ["Asia/Seoul"], 84: ["Asia/Ho_Chi_Minh"], 86: ["Asia/Shanghai"],
  90: ["Europe/Istanbul"], 91: ["Asia/Kolkata"], 92: ["Asia/Karachi"], 93: ["Asia/Kabul"],
  94: ["Asia/Colombo"], 95: ["Asia/Yangon"], 98: ["Asia/Tehran"],
  212: ["Africa/Casablanca"], 213: ["Africa/Algiers"], 216: ["Africa/Tunis"], 218: ["Africa/Tripoli"],
  233: ["Africa/Accra"], 234: ["Africa/Lagos"], 251: ["Africa/Addis_Ababa"], 254: ["Africa/Nairobi"],
  255: ["Africa/Dar_es_Salaam"], 256: ["Africa/Kampala"], 260: ["Africa/Lusaka"], 263: ["Africa/Harare"],
  351: ["Europe/Lisbon"], 352: ["Europe/Luxembourg"], 353: ["Europe/Dublin"], 354: ["Atlantic/Reykjavik"],
  356: ["Europe/Malta"], 357: ["Asia/Nicosia"], 358: ["Europe/Helsinki"], 359: ["Europe/Sofia"],
  370: ["Europe/Vilnius"], 371: ["Europe/Riga"], 372: ["Europe/Tallinn"], 380: ["Europe/Kyiv"],
  381: ["Europe/Belgrade"], 385: ["Europe/Zagreb"], 386: ["Europe/Ljubljana"],
  420: ["Europe/Prague"], 421: ["Europe/Bratislava"],
  502: ["America/Guatemala"], 503: ["America/El_Salvador"], 504: ["America/Tegucigalpa"],
  505: ["America/Managua"], 506: ["America/Costa_Rica"], 507: ["America/Panama"],
  591: ["America/La_Paz"], 593: ["America/Guayaquil"], 595: ["America/Asuncion"], 598: ["America/Montevideo"],
  852: ["Asia/Hong_Kong"], 853: ["Asia/Macau"], 855: ["Asia/Phnom_Penh"], 880: ["Asia/Dhaka"], 886: ["Asia/Taipei"],
  961: ["Asia/Beirut"], 962: ["Asia/Amman"], 964: ["Asia/Baghdad"], 965: ["Asia/Kuwait"], 966: ["Asia/Riyadh"],
  971: ["Asia/Dubai"], 972: ["Asia/Jerusalem"], 973: ["Asia/Bahrain"], 974: ["Asia/Qatar"], 977: ["Asia/Kathmandu"],
};

function toInternationalDigits(phone) {
  let s = String(phone || "").trim().replace(/\(0\)/g, "");
  const hasPlus = s.startsWith("+");
  const d = s.replace(/\D/g, "");
  if (!d) return null;
  if (hasPlus) return d;
  if (d.startsWith("00") && d.length > 8) return d.slice(2);
  if (d.startsWith("011") && d.length > 10) return d.slice(3);
  if (d.length === 10 && /^[2-9]/.test(d)) return "1" + d;
  if (d.length === 11 && d.startsWith("1")) return d;
  return null;
}

// -> { tz, approx, source } | null
export function resolveContactTimezone(phone) {
  const d = toInternationalDigits(phone);
  if (!d) return null;
  if (d.startsWith("1")) {
    if (d.length !== 11) return null;
    const area = d.slice(1, 4);
    return AREA[area] ? { tz: AREA[area], approx: false, source: `area code ${area}` } : null;
  }
  if (d.startsWith("7")) {
    const kz = /^7[67]/.test(d);
    return kz ? { tz: "Asia/Almaty", approx: true, source: "country code +7" } : { tz: "Europe/Moscow", approx: true, source: "country code +7" };
  }
  for (const len of [3, 2]) {
    const hit = CC[d.slice(0, len)];
    if (hit) return { tz: hit[0], approx: !!hit[1], source: `country code +${d.slice(0, len)}` };
  }
  return null;
}
