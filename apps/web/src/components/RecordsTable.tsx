import { Fragment, useMemo, useState } from 'react';
import type { SavedNote } from '@wardform/shared';

type SortMode =
  | 'newest'
  | 'oldest'
  | 'patient-asc'
  | 'patient-desc';

interface RecordsTableProps {
  notes: SavedNote[];
}

const soapSections = [
  ['Subjective', 'subjective'],
  ['Objective', 'objective'],
  ['Assessment', 'assessment'],
  ['Plan', 'plan'],
] as const;

function searchableText(note: SavedNote): string {
  return [
    note.encounter.patientName,
    note.content,
    note.soap.subjective,
    note.soap.objective,
    note.soap.assessment,
    note.soap.plan,
  ]
    .join(' ')
    .toLocaleLowerCase();
}

function patientName(note: SavedNote): string {
  return note.encounter.patientName.trim() || 'Clinical record';
}

export function RecordsTable({ notes }: RecordsTableProps) {
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] =
    useState<SortMode>('newest');
  const [expandedId, setExpandedId] =
    useState<string | null>(null);

  const patientSuggestions = useMemo(
    () =>
      Array.from(
        new Set(
          notes
            .map((note) => note.encounter.patientName.trim())
            .filter(Boolean),
        ),
      ).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    [notes],
  );

  const visibleNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    const filtered = normalizedQuery
      ? notes.filter((note) =>
          searchableText(note).includes(normalizedQuery),
        )
      : [...notes];

    return filtered.sort((a, b) => {
      if (sortMode === 'newest') {
        return (
          new Date(b.createdAt).getTime() -
          new Date(a.createdAt).getTime()
        );
      }

      if (sortMode === 'oldest') {
        return (
          new Date(a.createdAt).getTime() -
          new Date(b.createdAt).getTime()
        );
      }

      const comparison = patientName(a).localeCompare(
        patientName(b),
        undefined,
        { sensitivity: 'base' },
      );

      return sortMode === 'patient-asc'
        ? comparison
        : -comparison;
    });
  }, [notes, query, sortMode]);

  return (
    <div className="records-browser">
      <div className="records-toolbar">
        <div className="records-search">
          <label htmlFor="records-search">
            Search records
          </label>

          <div className="records-search__field">
            <input
              id="records-search"
              type="search"
              list="wardform-patient-suggestions"
              value={query}
              onChange={(event) =>
                setQuery(event.target.value)
              }
              placeholder="Patient, assessment, dictation…"
              autoComplete="off"
            />

            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear record search"
              >
                Clear
              </button>
            ) : null}
          </div>

          <datalist id="wardform-patient-suggestions">
            {patientSuggestions.map((name) => (
              <option value={name} key={name} />
            ))}
          </datalist>
        </div>

        <label className="records-sort">
          <span>Sort</span>
          <select
            value={sortMode}
            onChange={(event) =>
              setSortMode(event.target.value as SortMode)
            }
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="patient-asc">Patient A–Z</option>
            <option value="patient-desc">Patient Z–A</option>
          </select>
        </label>
      </div>

      <div className="records-result-count" aria-live="polite">
        {visibleNotes.length}{' '}
        {visibleNotes.length === 1 ? 'record' : 'records'}
        {query ? ' found' : ''}
      </div>

      {visibleNotes.length ? (
        <div className="records-table-shell">
          <table className="records-table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Assessment</th>
                <th>Saved</th>
                <th>
                  <span className="sr-only">Open record</span>
                </th>
              </tr>
            </thead>

            <tbody>
              {visibleNotes.map((note) => {
                const expanded = expandedId === note.id;

                return (
                  <Fragment key={note.id}>
                    <tr
                      className={
                        expanded
                          ? 'records-table__row records-table__row--open'
                          : 'records-table__row'
                      }
                      key={note.id}
                    >
                      <td data-label="Patient">
                        <strong>{patientName(note)}</strong>
                      </td>

                      <td
                        className="records-table__assessment"
                        data-label="Assessment"
                      >
                        {note.soap.assessment || '—'}
                      </td>

                      <td
                        className="records-table__date"
                        data-label="Saved"
                      >
                        <time dateTime={note.createdAt}>
                          {new Date(
                            note.createdAt,
                          ).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </time>
                      </td>

                      <td className="records-table__action">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedId(
                              expanded ? null : note.id,
                            )
                          }
                          aria-expanded={expanded}
                        >
                          {expanded ? 'Close' : 'Open'}
                        </button>
                      </td>
                    </tr>

                    {expanded ? (
                      <tr
                        className="records-table__detail-row"
                        key={`${note.id}-detail`}
                      >
                        <td colSpan={4}>
                          <div className="records-table__detail">
                            {soapSections.map(([label, key]) => (
                              <section key={key}>
                                <h3>{label}</h3>
                                <p>{note.soap[key] || '—'}</p>
                              </section>
                            ))}

                            <details>
                              <summary>Source dictation</summary>
                              <p>{note.content}</p>
                            </details>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          {query
            ? 'No records match this search.'
            : 'No saved clinical notes yet.'}
        </div>
      )}
    </div>
  );
}
