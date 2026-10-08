/** The subset of Test Orbit admin API responses YUKTI reads (see server/src/modules/admin in Test Orbit). */

export type SessionStatus = 'CREATED' | 'IN_PROGRESS' | 'INTERRUPTED' | 'FLAGGED_FOR_REVIEW' | 'SUBMITTED' | 'EXPIRED' | 'TERMINATED';
export type EvaluationStatus = 'NOT_EVALUATED' | 'PENDING_MANUAL_REVIEW' | 'COMPLETE';
export type ReentryStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'USED' | 'CANCELLED';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Scores {
  mcqScore: number | null;
  mcqMaxScore: number | null;
  codingScore: number | null;
  codingMaxScore: number | null;
  totalScore: number | null;
  maxScore: number | null;
  evaluationStatus: EvaluationStatus;
}

export interface SessionEvent {
  id: string;
  type: string;
  label: string;
  ruleGroup: string;
  eventCount: number;
  action: 'LOGGED' | 'WARNING' | 'TERMINATED' | 'IGNORED';
  warningNumber: number | null;
  details: unknown;
  createdAt: string;
}

export interface SessionQuestionDetail {
  id: string;
  position: number;
  section: string;
  sectionTitle: string;
  type: 'MCQ' | 'CODING';
  text: string;
  marks: number;
  answered: boolean;
  answerText: string | null;
  marksAwarded: number | null;
  evaluatedAt: string | null;
}

export interface SessionSection {
  key: string;
  title: string;
  total: number;
  answered: number;
  mcqScore: number;
  mcqMax: number;
  codingScore: number;
  codingMax: number;
  pending: number;
}

export interface ReentryRecord {
  id: string;
  trigger: 'NETWORK_INTERRUPTION' | 'POLICY_TERMINATION';
  status: ReentryStatus;
  remainingMsAtRequest: number;
  studentNote: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  timeAdjustmentMinutes: number;
  createdAt: string;
}

export interface SessionDetail {
  id: string;
  status: SessionStatus;
  statusLabel: string;
  paper: { id: string; name: string; domainName: string };
  durationMinutes: number;
  timeAdjustmentMinutes: number;
  startedAt: string | null;
  submittedAt: string | null;
  terminationReason: string | null;
  lastHeartbeatAt: string | null;
  resumeCount: number;
  remainingMs: number;
  timeUsedMs: number;
  scores: Scores;
  answeredCount: number;
  totalQuestions: number;
  sections: SessionSection[];
  questions: SessionQuestionDetail[];
  events: SessionEvent[];
  reentryRequests: ReentryRecord[];
}

export interface AssessmentDetail extends SessionDetail {
  student: { id: string; fullName: string; registrationNumber: string; mobileNumber: string; collegeName: string };
}

export interface StudentListItem {
  id: string;
  fullName: string;
  mobileNumber: string;
  collegeName: string;
}

export interface EducationEntry {
  level: 'SSC' | 'HSC' | 'UG' | 'PG';
  institutionName: string;
  yearOfCompletion: number;
  major: string | null;
  gradeType: 'PERCENTAGE' | 'CGPA_10' | 'CGPA_4' | 'GPA_5';
  score: number | null;
}

export interface StudentDetail {
  student: {
    id: string;
    fullName: string;
    registrationNumber: string;
    mobileNumber: string;
    collegeEmail: string;
    personalEmail: string;
    collegeName: string;
    location: string;
    department: string;
    yearOfPassing: number;
    domain: { slug: string; name: string };
    domainLockedAt: string | null;
    deviceCheckCompletedAt: string | null;
    createdAt: string;
    archivedAt: string | null;
    education: EducationEntry[];
  };
  photo: { available: boolean; confirmedAt?: string; retentionUntil?: string };
  sessions: SessionDetail[];
}

export interface AssessmentListItem {
  id: string;
  student: StudentListItem;
  domainName: string;
  paperName: string;
  status: SessionStatus;
  statusLabel: string;
  startedAt: string | null;
  submittedAt: string | null;
  totalScore: number | null;
  maxScore: number | null;
  evaluationStatus: EvaluationStatus;
}

export interface ReentryListItem {
  id: string;
  status: ReentryStatus;
  trigger: 'NETWORK_INTERRUPTION' | 'POLICY_TERMINATION';
  createdAt: string;
  decidedAt: string | null;
  student: StudentListItem;
  domainName: string;
  session: { id: string; status: SessionStatus; statusLabel: string; lastAnswerSavedAt: string | null; remainingMs: number; eventCount: number };
}

export interface PaperView {
  id: string;
  name: string;
  domain: { slug: string; name: string };
  durationMinutes: number;
  isActive: boolean;
  negativeMarkingEnabled: boolean;
  shuffleOptions: boolean;
  description: string;
  totalQuestions: number;
  activeSessionCount: number;
  editable: boolean;
  sections: { key: string; title: string; questionCount: number; marksPerQuestion: number | null; negativeMarksPerQuestion: number | null; available: { total: number; mcq: number; coding: number } }[];
  shortfalls: { section: string; required: number; available: number }[];
  ready: boolean;
}

export interface DomainView {
  slug: string;
  name: string;
  isActive: boolean;
  students: number;
  activePaper: { id: string; name: string; ready: boolean } | null;
  mcqQuestions: number;
  codingQuestions: number;
}

export interface ReportRow {
  sessionId: string;
  student: { id: string; fullName: string; registrationNumber: string; collegeName: string };
  domainName: string;
  status: SessionStatus;
  mcqScore: number | null;
  mcqMaxScore: number | null;
  totalScore: number | null;
  maxScore: number | null;
  evaluationStatus: EvaluationStatus;
}

export interface ReportPage extends Paged<ReportRow> {
  summary: {
    sessions: number;
    finalized: number;
    pendingReview: number;
    averageMcqScore: number | null;
    averageMcqMax: number | null;
    highestMcqScore: number | null;
    lowestMcqScore: number | null;
    averageTotalScore: number | null;
  };
}
