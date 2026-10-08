import type { WorkflowDefinition } from '../types.js';
import { candidateAuditWorkflow } from './candidateAudit.js';
import { evaluationQueueWorkflow } from './evaluationQueue.js';
import { incidentTriageWorkflow } from './incidentTriage.js';
import { paperAssemblyWorkflow } from './paperAssembly.js';
import { placementAnalyticsWorkflow } from './placementAnalytics.js';
import { reentryOutageWorkflow } from './reentryOutage.js';

export const WORKFLOWS: WorkflowDefinition[] = [
  reentryOutageWorkflow,
  paperAssemblyWorkflow,
  evaluationQueueWorkflow,
  candidateAuditWorkflow,
  incidentTriageWorkflow,
  placementAnalyticsWorkflow,
];
