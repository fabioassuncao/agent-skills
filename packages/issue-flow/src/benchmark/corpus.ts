export const TASK_CLASSES = ['trivial', 'small', 'medium', 'analysis'] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];

export interface CorpusTask {
  id: TaskClass;
  title: string;
  /** What a fixture repository should contain. */
  fixture: string;
  verification: 'none' | 'existing-tests' | 'tests-and-docs' | 'artifact-only';
  strategy: 'direct' | 'pipeline';
}

/**
 * Four representative tasks. The synthetic runner never opens a real repo;
 * `real` mode uses the same ids against a checkout the operator points at.
 */
export const CORPUS: readonly CorpusTask[] = [
  {
    id: 'trivial',
    title: 'Change one constant and its comment',
    fixture: '1–2 files, no test change',
    verification: 'none',
    strategy: 'direct',
  },
  {
    id: 'small',
    title: 'Fix a failing assertion in an existing test',
    fixture: 'correction against tests that already exist',
    verification: 'existing-tests',
    strategy: 'pipeline',
  },
  {
    id: 'medium',
    title: 'Add a function, tests and a README note',
    fixture: 'implementation plus tests plus documentation',
    verification: 'tests-and-docs',
    strategy: 'pipeline',
  },
  {
    id: 'analysis',
    title: 'Read the tree and write a short report',
    fixture: 'read-only artifact, no implementation',
    verification: 'artifact-only',
    strategy: 'direct',
  },
];

export const BENCH_AXES = [
  'task',
  'harness',
  'model',
  'effort',
  'verification',
  'strategy',
] as const;
