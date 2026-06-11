import { useEffect, useState } from 'react';

import { currentStreak } from './streak';
import type { CheckIn, Habit } from './types';

const STORAGE_KEY = 'habit-tracker.v1';

type Store = { habits: Habit[]; checkIns: CheckIn[] };

function load(): Store {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { habits: [], checkIns: [] };
  try {
    return JSON.parse(raw) as Store;
  } catch {
    return { habits: [], checkIns: [] };
  }
}

function save(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function App() {
  const [store, setStore] = useState<Store>(() => load());
  const today = todayStr();

  useEffect(() => save(store), [store]);

  const checkedToday = new Set(store.checkIns.filter((c) => c.date === today).map((c) => c.habitId));

  function toggleToday(habitId: string): void {
    if (checkedToday.has(habitId)) {
      setStore((s) => ({
        ...s,
        checkIns: s.checkIns.filter((c) => !(c.habitId === habitId && c.date === today)),
      }));
    } else {
      setStore((s) => ({
        ...s,
        checkIns: [
          ...s.checkIns,
          { id: crypto.randomUUID(), habitId, date: today, createdAt: Date.now() },
        ],
      }));
    }
  }

  function addHabit(name: string): void {
    if (!name.trim()) return;
    setStore((s) => ({
      ...s,
      habits: [
        ...s.habits,
        { id: crypto.randomUUID(), name: name.trim(), frequency: 'daily', createdAt: Date.now() },
      ],
    }));
  }

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 520, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Habits</h1>
      {store.habits.length === 0 ? (
        <p style={{ color: '#777' }}>
          No habits yet. Try <button onClick={() => addHabit('drink water')}>drink water</button>.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {store.habits.map((h) => {
            const habitCheckIns = store.checkIns.filter((c) => c.habitId === h.id);
            return (
              <li
                key={h.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.5rem 0',
                  borderBottom: '1px solid #eee',
                }}
              >
                <span>{h.name}</span>
                <span>
                  <small style={{ color: '#777', marginRight: 12 }}>
                    {currentStreak(habitCheckIns, today)} day streak
                  </small>
                  <button onClick={() => toggleToday(h.id)}>
                    {checkedToday.has(h.id) ? '✓ done' : 'check off'}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <AddHabitForm onAdd={addHabit} />
    </main>
  );
}

function AddHabitForm({ onAdd }: { onAdd: (name: string) => void }): JSX.Element {
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(name);
        setName('');
      }}
      style={{ marginTop: '1rem', display: 'flex', gap: 8 }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="new habit…"
        style={{ flex: 1, padding: '0.5rem' }}
      />
      <button type="submit">add</button>
    </form>
  );
}
