import { X } from 'lucide-react';

const SECTIONS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: 'Navigate',
    items: [
      ['Pinch · ⌘/Ctrl + scroll', 'Zoom around the pointer'],
      ['Two-finger swipe sideways', 'Pan in time'],
      ['Scroll', 'Scroll tracks'],
      ['W / S', 'Zoom in / out (hold Shift for faster)'],
      ['A / D', 'Pan left / right'],
      ['⌥ Option-drag · Space-drag', 'Grab and pan'],
      ['Drag on the overview', 'Move the visible window'],
      ['0', 'Fit the whole profile'],
    ],
  },
  {
    title: 'Select',
    items: [
      ['Click', 'Select an event (shows details and launch links)'],
      ['Double-click', 'Zoom to an event'],
      ['Drag on timeline or ruler', 'Select a time range'],
      ['← / →', 'Previous / next event on the same row'],
      ['F', 'Zoom to selection or range'],
      ['Esc', 'Clear selection, then range, then search'],
    ],
  },
  {
    title: 'Find',
    items: [
      ['/ · ⌘F', 'Search event names (substring or /regex/)'],
      ['Enter · N', 'Next match'],
      ['Shift+Enter · Shift+N', 'Previous match'],
      ['Click a stats row', 'Highlight every instance on the timeline'],
      ['⌘O', 'Open another profile'],
    ],
  },
];

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="modal-head">
          <h3>Shortcuts</h3>
          <button className="icon-btn sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="help-grid">
          {SECTIONS.map((s) => (
            <div key={s.title}>
              <h4>{s.title}</h4>
              {s.items.map(([k, v]) => (
                <div key={k} className="help-row">
                  <kbd>{k}</kbd>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
