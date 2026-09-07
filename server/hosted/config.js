export function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function trustedProxyHops(value) {
  return boundedInteger(value, 0, 0, 8);
}
