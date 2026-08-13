import type { SavedNote } from '@wardform/shared';

interface GridNoteCardProps {
  note: SavedNote;
}

const sections = [
  ['Subjective', 'subjective'],
  ['Objective', 'objective'],
  ['Assessment', 'assessment'],
  ['Plan', 'plan'],
] as const;

export function GridNoteCard({ note }: GridNoteCardProps) {
  return (
    <article className="note-card">
      <header className="note-card__header">
        <div>
          <div className="eyebrow">
            {note.encounter.patientName || 'Clinical record'}
          </div>
          <time dateTime={note.createdAt}>
            {new Date(note.createdAt).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        </div>
        <span className="saved-badge">Saved</span>
      </header>

      <div className="soap-readout">
        {sections.map(([label, key]) => (
          <section className="soap-readout__section" key={key}>
            <h3>{label}</h3>
            <p>{note.soap[key] || '—'}</p>
          </section>
        ))}
      </div>
    </article>
  );
}
