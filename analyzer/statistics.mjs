/**
 * Pure statistical functions for WarEra Build Analyzer
 */

export function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  const sum = arr.reduce((acc, v) => acc + (Number(v) || 0), 0);
  return sum / arr.length;
}

export function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stdDev(arr) {
  if (!arr || arr.length <= 1) return 0;
  const avg = mean(arr);
  const squareDiffs = arr.map((v) => {
    const diff = (Number(v) || 0) - avg;
    return diff * diff;
  });
  return Math.sqrt(mean(squareDiffs));
}

export function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) return sorted[lower];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function iqr(arr) {
  const p25 = percentile(arr, 25);
  const p75 = percentile(arr, 75);
  return p75 - p25;
}

/**
 * Identify outliers using standard IQR rule (default 1.5 * IQR, or 2.5 for extreme)
 */
export function detectOutliers(items, valueSelector = (x) => x, multiplier = 1.5) {
  if (!items || items.length < 4) {
    return { normal: items, outliers: [], lowerBound: -Infinity, upperBound: Infinity };
  }

  const values = items.map(valueSelector).map(Number).filter((n) => !isNaN(n));
  const p25 = percentile(values, 25);
  const p75 = percentile(values, 75);
  const range = p75 - p25;
  const lowerBound = p25 - multiplier * range;
  const upperBound = p75 + multiplier * range;

  const normal = [];
  const outliers = [];

  for (const item of items) {
    const val = Number(valueSelector(item));
    if (val < lowerBound || val > upperBound) {
      outliers.push(item);
    } else {
      normal.push(item);
    }
  }

  return { normal, outliers, lowerBound, upperBound };
}

/**
 * Compute ranks with tie-averaging
 */
function rankArray(arr) {
  const indexed = arr.map((val, idx) => ({ val, idx }));
  indexed.sort((a, b) => a.val - b.val);

  const ranks = new Array(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].val === indexed[i].val) {
      j++;
    }
    // Average rank for ties (1-based)
    const avgRank = 1 + (i + j - 1) / 2;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].idx] = avgRank;
    }
    i = j;
  }
  return ranks;
}

/**
 * Spearman rank correlation coefficient between two numeric vectors
 * Returns number between -1.0 and +1.0
 */
export function spearmanCorrelation(xArr, yArr) {
  if (!xArr || !yArr || xArr.length !== yArr.length || xArr.length < 3) {
    return 0;
  }

  // Check if all values in either array are identical
  const allSameX = xArr.every((v) => v === xArr[0]);
  const allSameY = yArr.every((v) => v === yArr[0]);
  if (allSameX || allSameY) return 0;

  const rankX = rankArray(xArr);
  const rankY = rankArray(yArr);

  const n = xArr.length;
  let dSquaredSum = 0;
  for (let i = 0; i < n; i++) {
    const d = rankX[i] - rankY[i];
    dSquaredSum += d * d;
  }

  // Standard Spearman formula: 1 - (6 * sum(d^2)) / (n * (n^2 - 1))
  const rho = 1 - (6 * dSquaredSum) / (n * (n * n - 1));
  return Math.max(-1, Math.min(1, Math.round(rho * 1000) / 1000));
}

/**
 * Count frequencies and percentages of categorical values
 */
export function frequencyMap(arr) {
  const counts = {};
  const total = arr.length;
  if (total === 0) return {};

  for (const item of arr) {
    const key = String(item ?? "none");
    counts[key] = (counts[key] || 0) + 1;
  }

  const result = {};
  for (const [k, count] of Object.entries(counts)) {
    result[k] = {
      count,
      pct: Math.round((count / total) * 100),
    };
  }
  return result;
}

/**
 * Format correlation strength label
 */
export function correlationEvidence(rho) {
  const abs = Math.abs(rho);
  if (abs >= 0.5) return "Strong evidence";
  if (abs >= 0.25) return "Moderate evidence";
  return "Weak evidence";
}
