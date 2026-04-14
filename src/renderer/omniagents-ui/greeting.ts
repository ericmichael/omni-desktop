const MORNING: string[] = [
  'Good morning',
  'Morning',
  'Hey, good morning',
];

const AFTERNOON: string[] = [
  'Good afternoon',
  'Hey there',
  'How\'s it going?',
];

const EVENING: string[] = [
  'Good evening',
  'Hey, good evening',
];

const FRIDAY: string[] = [
  'Happy Friday',
];

const WEEKEND: string[] = [
  'Hey',
  'What\'s up?',
  'How\'s it going?',
];

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Warm, human-like greeting based on time and day. Stable per call — cache the result. */
export function getGreeting(): string {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday

  if (day === 5 && hour >= 6 && hour < 17) {
return pick(FRIDAY);
}
  if (day === 0 || day === 6) {
return pick(WEEKEND);
}

  if (hour < 12) {
return pick(MORNING);
}
  if (hour < 17) {
return pick(AFTERNOON);
}
  return pick(EVENING);
}
