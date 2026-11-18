export const CRO_LIMITS = {
  maxPages: 7, maxItems: 25, topItems: 5,
  navTimeoutMs: 25_000, flowTimeoutMs: 15_000,
  staleRunningMs: 30 * 60 * 1000,
  textCap: 50_000, shotMaxHeight: 6000, desktopTopHeight: 1800, mobileTopHeight: 1600,
  retryDropShare: 0.4, minItems: 3,
};

export const CRO_DESKTOP = { width: 1440, height: 900 };
export const CRO_MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
