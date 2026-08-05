import { atom } from 'nanostores';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar, SidebarMenu, SidebarProvider, SidebarTrigger } from '@/renderer/ds/ui/sidebar';
import type { Project } from '@/shared/types';

import { NavSection } from './NavSection';

const projectMocks = vi.hoisted(() => ({
  goToProject: vi.fn(),
  updateProject: vi.fn(),
  renameProject: vi.fn(),
}));

vi.mock('@/renderer/features/Code/SessionsSection', () => ({
  ProjectSessionRows: () => <div data-testid="project-sessions">Session</div>,
}));
vi.mock('@/renderer/features/Projects/ProjectCreateDialog', () => ({ ProjectCreateDialog: () => null }));
vi.mock('@/renderer/features/Tickets/state', () => ({
  $needsYouByProject: atom({}),
  $tickets: atom([]),
  $ticketsView: atom({ kind: 'all' }),
  ticketApi: projectMocks,
  viewToNavValue: vi.fn(),
}));

import { ProjectRow } from '@/renderer/features/Tickets/ProjectsSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode): void {
  act(() => root.render(<SidebarProvider>{node}</SidebarProvider>));
}

function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  projectMocks.goToProject.mockClear();
  projectMocks.updateProject.mockClear();
  projectMocks.renameProject.mockClear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('sidebar behavior contracts', () => {
  it('uses the mobile drawer through the full range below the shadcn md breakpoint', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });

    render(
      <>
        <Sidebar>
          <span>Navigation</span>
        </Sidebar>
        <SidebarTrigger aria-label="Open navigation" />
      </>
    );

    expect(host.querySelector('[data-slot="sidebar"][data-state]')).toBeNull();
    click(host.querySelector('button[aria-label="Open navigation"]')!);
    expect(document.body.querySelector('[data-slot="sidebar"][data-mobile="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Navigation');
  });

  it('uses the shared trigger to restore an off-canvas desktop sidebar', () => {
    render(
      <>
        <Sidebar>
          <span>Navigation</span>
        </Sidebar>
        <SidebarTrigger aria-label="Open navigation" />
      </>
    );

    const sidebar = host.querySelector('[data-slot="sidebar"][data-state]');
    const container = host.querySelector('[data-slot="sidebar-container"]');
    const trigger = host.querySelector('button[aria-label="Open navigation"]');
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');
    expect(sidebar?.classList.contains('hidden')).toBe(false);
    expect(container?.classList.contains('hidden')).toBe(false);

    click(trigger!);
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');

    click(trigger!);
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');
  });

  it('persists the exact collapsed state for navigation sections', () => {
    const id = `projects-${Math.random()}`;
    render(
      <NavSection id={id} label="Projects">
        <span>Project contents</span>
      </NavSection>
    );

    const trigger = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Projects'));
    expect(trigger).toBeDefined();
    click(trigger!);

    expect(JSON.parse(localStorage.getItem('omni.navSectionsCollapsed') ?? '{}')).toEqual({ [id]: true });
    expect(trigger?.getAttribute('data-state')).toBe('closed');

    click(trigger!);
    expect(JSON.parse(localStorage.getItem('omni.navSectionsCollapsed') ?? '{}')).toEqual({});
    expect(trigger?.getAttribute('data-state')).toBe('open');
  });

  it('separates project disclosure, Open, and overflow actions', () => {
    const project = {
      id: 'project-1',
      label: 'Omni Ecosystem',
      pinnedAt: null,
    } as Project;

    render(
      <SidebarMenu>
        <ProjectRow project={project} needsYou={2} selected={false} hasSessions={false} sessionTitles={new Map()} />
      </SidebarMenu>
    );

    const disclosure = host.querySelector('button[aria-label="Show sessions for Omni Ecosystem"]');
    const open = host.querySelector('button[aria-label="Open Omni Ecosystem"]');
    const overflow = host.querySelector('button[aria-label="Project actions"]');
    expect(disclosure).not.toBeNull();
    expect(open).not.toBeNull();
    expect(overflow).not.toBeNull();
    expect(open?.parentElement).not.toBe(disclosure);
    expect(overflow?.parentElement).not.toBe(disclosure);

    click(disclosure!);
    expect(projectMocks.goToProject).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('omni.sidebarExpandedProjects') ?? '{}')).toEqual({ 'project-1': true });

    act(() => overflow!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    click(overflow!);
    expect(projectMocks.goToProject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Rename');

    click(open!);
    expect(projectMocks.goToProject).toHaveBeenCalledWith('project-1');
  });

  it('groups sessions under their project by default and persists an explicit collapse', () => {
    const project = {
      id: 'project-with-sessions',
      label: 'Omni Ecosystem',
      pinnedAt: null,
    } as Project;

    render(
      <SidebarMenu>
        <ProjectRow project={project} needsYou={0} selected={false} hasSessions sessionTitles={new Map()} />
      </SidebarMenu>
    );

    expect(host.querySelector('[data-testid="project-sessions"]')).not.toBeNull();
    click(host.querySelector('button[aria-label="Hide sessions for Omni Ecosystem"]')!);
    expect(host.querySelector('[data-testid="project-sessions"]')).toBeNull();
    expect(
      (JSON.parse(localStorage.getItem('omni.sidebarExpandedProjects') ?? '{}') as Record<string, boolean>)[
        'project-with-sessions'
      ]
    ).toBe(false);
  });

  it('keeps row actions in a sibling reflow slot with an explicit closed state', () => {
    render(
      <SidebarMenu>
        <li className="sidebar-row">
          <button data-sidebar="menu-button">A full-width session label</button>
          <span data-sidebar="menu-badge">2</span>
          <span data-sidebar-row-actions="" data-state="closed">
            <button data-sidebar="menu-action">Actions</button>
          </span>
        </li>
      </SidebarMenu>
    );

    const row = host.querySelector('.sidebar-row');
    expect(row?.querySelector(':scope > [data-sidebar="menu-button"]')).not.toBeNull();
    expect(row?.querySelector(':scope > [data-sidebar="menu-badge"]')).not.toBeNull();
    expect(row?.querySelector(':scope > [data-sidebar-row-actions]')).not.toBeNull();
    expect(row?.querySelector('[data-sidebar-row-actions]')?.getAttribute('data-state')).toBe('closed');
  });

  it('keeps an active session status inside the selected row surface', () => {
    render(
      <SidebarMenu>
        <li className="sidebar-row">
          <button data-sidebar="menu-button" data-active="true">
            Active session
          </button>
          <span data-sidebar="menu-badge">Working</span>
        </li>
      </SidebarMenu>
    );

    const row = host.querySelector('.sidebar-row');
    expect(row?.matches(":has(> [data-sidebar='menu-button'][data-active='true'])")).toBe(true);
    expect(row?.querySelector(":scope > [data-sidebar='menu-badge']")).not.toBeNull();
  });
});
