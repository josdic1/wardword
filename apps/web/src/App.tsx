import { useEffect, useRef, useState } from 'react';
import type {
  EncounterMetadata,
  SoapFields,
  SavedNote,
} from '@wardform/shared';
import { RecordsTable } from './components/RecordsTable';
import {
  fetchNotes,
  previewNote,
  saveNote,
  transcribeRecording,
} from './services/apiClient';

const emptyEncounter: EncounterMetadata = {
  patientName: '',
};

const emptySoap: SoapFields = {
  subjective: '',
  objective: '',
  assessment: '',
  plan: '',
};

type Screen = 'capture' | 'review' | 'records';

type ProcessingStage =
  | 'transcribing'
  | 'structuring'
  | 'saving'
  | null;

const processingCopy = {
  transcribing: {
    eyebrow: 'Processing dictation',
    title: 'Transcribing audio…',
    detail: 'Converting the recording into a clinical transcript.',
  },
  structuring: {
    eyebrow: 'Preparing clinical record',
    title: 'Normalizing terminology and structuring SOAP…',
    detail: 'Organizing the transcript for review.',
  },
  saving: {
    eyebrow: 'Saving record',
    title: 'Saving reviewed clinical note…',
    detail: 'Writing the verified record to the archive.',
  },
} as const;

export function App() {
  const [screen, setScreen] = useState<Screen>('capture');
  const [notes, setNotes] = useState<SavedNote[]>([]);
  const [textInput, setTextInput] = useState('');
  const [encounter, setEncounter] =
    useState<EncounterMetadata>(emptyEncounter);
  const [soap, setSoap] = useState<SoapFields>(emptySoap);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [processingStage, setProcessingStage] =
    useState<ProcessingStage>(null);
  const [recording, setRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [extractionMode, setExtractionMode] = useState<'local-ai' | 'structured-fallback' | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const transcriptRef = useRef('');

  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveformFrameRef = useRef<number | null>(null);

  function cancelWaveformFrame() {
    if (waveformFrameRef.current !== null) {
      cancelAnimationFrame(waveformFrameRef.current);
      waveformFrameRef.current = null;
    }
  }

  function drawWaveform() {
    const canvas = waveformCanvasRef.current;
    const analyser = analyserRef.current;

    if (!canvas || !analyser) {
      return;
    }

    const context = canvas.getContext('2d');

    if (!context) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(rect.width * ratio));
    const pixelHeight = Math.max(1, Math.round(rect.height * ratio));

    if (
      canvas.width !== pixelWidth ||
      canvas.height !== pixelHeight
    ) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const values = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(values);

    context.beginPath();
    context.lineWidth = 1.8;
    context.strokeStyle = '#1f5d48';
    context.lineJoin = 'round';
    context.lineCap = 'round';

    const centerY = rect.height / 2;
    const usableHeight = Math.min(rect.height * 0.58, 130);

    values.forEach((value, index) => {
      const x =
        (index / Math.max(1, values.length - 1)) *
        rect.width;

      const normalized = (value - 128) / 128;
      const y = centerY + normalized * usableHeight;

      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });

    context.stroke();

    waveformFrameRef.current =
      requestAnimationFrame(drawWaveform);
  }

  function startAudioAnalysis(stream: MediaStream) {
    if (typeof AudioContext === 'undefined') {
      return;
    }

    const audioContext = new AudioContext();
    const source =
      audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();

    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;

    source.connect(analyser);

    audioContextRef.current = audioContext;
    audioSourceRef.current = source;
    analyserRef.current = analyser;
  }

  function stopAudioAnalysis() {
    cancelWaveformFrame();

    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;
    analyserRef.current = null;

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;

    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => undefined);
    }
  }

  async function loadNotes() {
    try {
      setNotes(await fetchNotes());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to load records.');
    }
  }

  useEffect(() => {
    void loadNotes();
  }, []);

  useEffect(() => {
    cancelWaveformFrame();

    if (recording && !recordingPaused) {
      waveformFrameRef.current =
        requestAnimationFrame(drawWaveform);
    }
  }, [recording, recordingPaused]);

  useEffect(() => {
    return () => {
      stopAudioAnalysis();
    };
  }, []);

  async function buildPreview(content = transcriptRef.current || textInput) {
    const clean = content.trim();
    if (!clean) {
      setStatus('Enter or dictate a clinical note first.');
      return;
    }

    setBusy(true);
    setProcessingStage('structuring');
    setStatus('Structuring note…');

    try {
      const preview = await previewNote(clean);
      setTextInput(preview.content);
      transcriptRef.current = preview.content;
      setEncounter(preview.encounter);
      setSoap(preview.soap);
      setExtractionMode(preview.extractionMode);
      setScreen('review');
      setStatus('Review every field before saving.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to structure this note.');
    } finally {
      setBusy(false);
      setProcessingStage(null);
    }
  }

  async function startRecording() {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      setStatus(
        'Microphone recording is unavailable in this browser or connection.',
      );
      return;
    }

    setBusy(true);
    setStatus('Requesting microphone access…');

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      transcriptRef.current = textInput.trim();
      startAudioAnalysis(stream);

      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ];

      const mimeType = preferredTypes.find((type) =>
        MediaRecorder.isTypeSupported(type),
      );

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((track) =>
          track.stop(),
        );

        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;
        audioChunksRef.current = [];
        stopAudioAnalysis();

        setRecording(false);
        setRecordingPaused(false);
        setBusy(false);
        setStatus(
          'Recording failed. You can type or paste the dictation instead.',
        );
      };

      recorder.onstop = async () => {
        setRecording(false);
        setRecordingPaused(false);
        setBusy(true);
        setProcessingStage('transcribing');
        setStatus('Transcribing…');

        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];

        const recordingType =
          recorder.mimeType ||
          chunks[0]?.type ||
          'audio/webm';

        const audio = new Blob(
          chunks,
          { type: recordingType },
        );

        stream.getTracks().forEach((track) =>
          track.stop(),
        );

        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;
        stopAudioAnalysis();

        try {
          const transcript =
            await transcribeRecording(audio);

          const combined = [
            transcriptRef.current,
            transcript,
          ]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          transcriptRef.current = combined;
          setTextInput(combined);

          await buildPreview(combined);
        } catch (error) {
          setBusy(false);
          setProcessingStage(null);
          setStatus(
            error instanceof Error
              ? error.message
              : 'Unable to transcribe this recording.',
          );
        }
      };

      recorder.start();

      setRecording(true);
      setRecordingPaused(false);
      setBusy(false);
      setStatus('Recording…');
    } catch (error) {
      stopAudioAnalysis();
      setBusy(false);
      setRecording(false);
      setRecordingPaused(false);

      setStatus(
        error instanceof Error
          ? `Microphone unavailable: ${error.message}`
          : 'Microphone permission was not granted.',
      );
    }
  }

  function toggleRecordingPause() {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      return;
    }

    if (recorder.state === 'recording') {
      recorder.pause();
      setRecordingPaused(true);
      setStatus('Recording paused.');
      return;
    }

    if (recorder.state === 'paused') {
      recorder.resume();
      setRecordingPaused(false);
      setStatus('Recording…');
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      return;
    }

    setStatus('Finishing recording…');
    recorder.stop();
  }

  function clearCurrentNote() {
    if (busy || recording) {
      return;
    }

    setTextInput('');
    transcriptRef.current = '';
    setEncounter(emptyEncounter);
    setSoap(emptySoap);
    setExtractionMode(null);
    setScreen('capture');
    setStatus('New note ready.');
  }

  function updateSoap(field: keyof SoapFields, value: string) {
    setSoap((current) => ({ ...current, [field]: value }));
  }

  async function handleSave() {
    setBusy(true);
    setProcessingStage('saving');
    setStatus('Saving reviewed note…');

    try {
      const saved = await saveNote(
        textInput,
        encounter,
        soap,
      );
      setNotes((current) => [saved, ...current]);
      setTextInput('');
      transcriptRef.current = '';
      setEncounter(emptyEncounter);
      setSoap(emptySoap);
      setExtractionMode(null);
      setScreen('capture');
      setStatus('Clinical note saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to save this note.');
    } finally {
      setBusy(false);
      setProcessingStage(null);
    }
  }

  return (
    <div className={`app-shell app-shell--${screen}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">W</div>
          <div>
            <div className="brand-name">WardWord</div>
            <div className="brand-subtitle">Clinical dictation</div>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="privacy-indicator">
            <span /> Clinician review
          </div>

          {screen !== 'review' ? (
            <button
              className="topbar-nav-button"
              type="button"
              onClick={() =>
                setScreen(
                  screen === 'records'
                    ? 'capture'
                    : 'records',
                )
              }
              disabled={busy || recording}
            >
              {screen === 'records'
                ? 'Dictate'
                : `Records ${notes.length}`}
            </button>
          ) : null}
        </div>
      </header>

      <main className={`page page--${screen}`}>
        {screen === 'capture' ? (
          <section
            className={
              processingStage
                ? 'workspace workspace--processing-hidden'
                : 'workspace'
            }
            aria-labelledby="capture-heading"
          >
            <div className="section-heading">
              <div>
                <div className="eyebrow">New note</div>
                <h1 id="capture-heading">Dictate. Review. Save.</h1>
              </div>
              <p>Nothing is committed until the SOAP fields are reviewed.</p>
            </div>

            <div className="capture-card">
              <div className="capture-field-header">
                <label htmlFor="dictation">Clinical dictation</label>
                <button
                  className="clear-note-button"
                  type="button"
                  onClick={clearCurrentNote}
                  disabled={busy || recording || !textInput.trim()}
                >
                  Clear
                </button>
              </div>
              <div className="capture-transcript-stage">
                <textarea
                  id="dictation"
                  value={textInput}
                  onChange={(event) => {
                    setTextInput(event.target.value);
                    transcriptRef.current = event.target.value;
                  }}
                  placeholder="Dictate the visit naturally, or paste a test script here."
                  rows={9}
                  disabled={recording || busy}
                />

                {recording ? (
                  <div
                    className={
                      recordingPaused
                        ? 'recording-waveform recording-waveform--paused'
                        : 'recording-waveform'
                    }
                  >
                    <canvas
                      ref={waveformCanvasRef}
                      aria-hidden="true"
                    />

                    <div className="recording-waveform__status">
                      <span aria-hidden="true" />
                      {recordingPaused ? 'Paused' : 'Recording'}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="capture-actions">
                {recording ? (
                  <>
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={toggleRecordingPause}
                      disabled={busy}
                    >
                      {recordingPaused ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      className={
                        recordingPaused
                          ? 'button button--danger'
                          : 'button button--danger button--recording'
                      }
                      type="button"
                      onClick={stopRecording}
                      disabled={busy}
                    >
                      Stop & review
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={startRecording}
                      disabled={busy}
                    >
                      Start dictation
                    </button>
                    <button
                      className="button button--primary"
                      type="button"
                      onClick={() => void buildPreview()}
                      disabled={busy || !textInput.trim()}
                    >
                      {busy ? 'Structuring…' : 'Review SOAP'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>
        ) : screen === 'review' ? (
          <section className="workspace" aria-labelledby="review-heading">
            <div className="section-heading section-heading--review">
              <div>
                <div className="eyebrow">Review</div>
                <h1 id="review-heading">Verify the clinical record.</h1>
              </div>
              <p>Edit any field before saving.</p>
            </div>

            <div className="review-card">
              <div className="review-scroll">
                <label className="review-field">
                <span>Patient</span>
                <input
                  type="text"
                  value={encounter.patientName}
                  onChange={(event) =>
                    setEncounter({
                      patientName: event.target.value,
                    })
                  }
                  placeholder="Patient name"
                />
              </label>

              {(['subjective', 'objective', 'assessment', 'plan'] as const).map((field) => (
                <label className="review-field" key={field}>
                  <span>{field}</span>
                  <textarea
                    value={soap[field]}
                    onChange={(event) => updateSoap(field, event.target.value)}
                    rows={field === 'subjective' || field === 'objective' ? 5 : 3}
                  />
                </label>
              ))}

              <details className="source-details">
                <summary>Source dictation</summary>
                <p>{textInput}</p>
              </details>

              </div>

              <div className="review-actions">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setScreen('capture')}
                  disabled={busy}
                >
                  Back to dictation
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={busy}
                >
                  {busy ? 'Saving…' : 'Save clinical note'}
                </button>
              </div>
            </div>

            {extractionMode === 'structured-fallback' ? (
              <p className="processing-note">AI structuring was unavailable. WardWord separated the dictated sections without inventing missing clinical content.</p>
            ) : null}
          </section>
        ) : (
          <section
            className="workspace records-screen"
            aria-labelledby="records-heading"
          >
            <div className="section-heading records-screen__heading">
              <div>
                <div className="eyebrow">Records</div>
                <h1 id="records-heading">
                  Saved clinical notes.
                </h1>
              </div>

              <p>
                {notes.length}{' '}
                {notes.length === 1
                  ? 'saved record'
                  : 'saved records'}
              </p>
            </div>

            <RecordsTable notes={notes} />
          </section>
        )}

        {processingStage && screen !== 'records' ? (
          <div
            className={`processing-panel processing-panel--${processingStage}`}
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="processing-panel__copy">
              <div>
                <div className="eyebrow">
                  {processingCopy[processingStage].eyebrow}
                </div>
                <strong>
                  {processingCopy[processingStage].title}
                </strong>
              </div>
              <span>Processing</span>
            </div>

            <div className="processing-skeleton" aria-hidden="true">
              <div className="processing-skeleton__patient">
                <span>Patient</span>
                <div className="processing-skeleton__line processing-skeleton__line--patient" />
              </div>

              <div className="processing-skeleton__section">
                <span>Subjective</span>
                <div className="processing-skeleton__line" />
                <div className="processing-skeleton__line processing-skeleton__line--medium" />
              </div>

              <div className="processing-skeleton__section">
                <span>Objective</span>
                <div className="processing-skeleton__line" />
                <div className="processing-skeleton__line processing-skeleton__line--long" />
              </div>

              <div className="processing-skeleton__section">
                <span>Assessment</span>
                <div className="processing-skeleton__line processing-skeleton__line--assessment" />
              </div>

              <div className="processing-skeleton__section">
                <span>Plan</span>
                <div className="processing-skeleton__line" />
                <div className="processing-skeleton__line processing-skeleton__line--medium" />
              </div>
            </div>

            <p className="processing-panel__detail">
              {processingCopy[processingStage].detail}
            </p>
          </div>
        ) : null}

        {status && screen !== 'records' ? (
          <div className="status-line">
            {status}
          </div>
        ) : null}

      </main>

      {screen !== 'review' ? (
        <nav
          className="mobile-app-nav"
          aria-label="WardWord sections"
        >
          <button
            className={
              screen === 'capture'
                ? 'mobile-app-nav__item mobile-app-nav__item--active'
                : 'mobile-app-nav__item'
            }
            type="button"
            onClick={() => setScreen('capture')}
            disabled={busy || recording}
          >
            Dictate
          </button>

          <button
            className={
              screen === 'records'
                ? 'mobile-app-nav__item mobile-app-nav__item--active'
                : 'mobile-app-nav__item'
            }
            type="button"
            onClick={() => setScreen('records')}
            disabled={busy || recording}
          >
            Records
            <span>{notes.length}</span>
          </button>
        </nav>
      ) : null}
    </div>
  );
}

export default App;
