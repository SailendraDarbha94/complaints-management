import { pgEnum } from 'drizzle-orm/pg-core';
import {
  CASE_KINDS,
  CASE_OUTCOMES,
  CASE_STATES,
  CLOSURE_REASONS,
  CONTACT_CHANNELS,
  CONTACT_DIRECTIONS,
  CORRESPONDENCE_KINDS,
  DATE_SOURCES,
  DOCUMENT_CLASSES,
  DOCUMENT_STATUSES,
  FOLLOWUP_STAGES,
  FOLLOWUP_STATUSES,
  INTAKE_SOURCES,
  MILESTONES,
  NOTICE_STATES,
  PARTY_KINDS,
  PARTY_ROLES,
  ROLES,
  RTI_CHANNELS,
  RTI_DECISIONS,
  RTI_EXEMPTION_SECTIONS,
  RTI_STATES,
  SERVICE_MODES,
  WAITING_ON,
} from '@ksdc/contracts';

/**
 * Postgres enums are generated from the @ksdc/contracts tuples — one source, so a value
 * can never be valid in the API and invalid in the database. `enum-parity.test.ts`
 * asserts the two sets are identical against a live database.
 */

export const caseKindEnum = pgEnum('case_kind', CASE_KINDS);
export const caseStateEnum = pgEnum('case_state', CASE_STATES);
export const waitingOnEnum = pgEnum('waiting_on', WAITING_ON);
export const intakeSourceEnum = pgEnum('intake_source', INTAKE_SOURCES);
export const closureReasonEnum = pgEnum('closure_reason', CLOSURE_REASONS);
export const caseOutcomeEnum = pgEnum('case_outcome', CASE_OUTCOMES);

export const partyRoleEnum = pgEnum('party_role', PARTY_ROLES);
export const partyKindEnum = pgEnum('party_kind', PARTY_KINDS);
export const noticeStateEnum = pgEnum('notice_state', NOTICE_STATES);
export const serviceModeEnum = pgEnum('service_mode', SERVICE_MODES);

export const contactChannelEnum = pgEnum('contact_channel', CONTACT_CHANNELS);
export const contactDirectionEnum = pgEnum('contact_direction', CONTACT_DIRECTIONS);
export const correspondenceKindEnum = pgEnum('correspondence_kind', CORRESPONDENCE_KINDS);

export const milestoneEnum = pgEnum('milestone', MILESTONES);
export const dateSourceEnum = pgEnum('date_source', DATE_SOURCES);

export const followupStageEnum = pgEnum('followup_stage', FOLLOWUP_STAGES);
export const followupStatusEnum = pgEnum('followup_status', FOLLOWUP_STATUSES);

export const roleEnum = pgEnum('council_role', ROLES);
export const documentStatusEnum = pgEnum('document_status', DOCUMENT_STATUSES);
export const documentClassEnum = pgEnum('document_class', DOCUMENT_CLASSES);

export const rtiStateEnum = pgEnum('rti_state', RTI_STATES);
export const rtiChannelEnum = pgEnum('rti_channel', RTI_CHANNELS);
export const rtiDecisionEnum = pgEnum('rti_decision', RTI_DECISIONS);
/** s.8(1)(a) to (j) and s.9 only. Section 11 is absent by design - see rti.ts. */
export const rtiExemptionSectionEnum = pgEnum('rti_exemption_section', RTI_EXEMPTION_SECTIONS);
