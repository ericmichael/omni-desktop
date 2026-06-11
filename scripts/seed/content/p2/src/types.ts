export type Habit = {
  id: string;
  name: string;
  /** How often the user wants to do this habit. */
  frequency: 'daily' | 'weekly';
  createdAt: number;
};

export type CheckIn = {
  id: string;
  habitId: string;
  /** YYYY-MM-DD in the user's local timezone. */
  date: string;
  createdAt: number;
};
