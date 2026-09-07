import type { ConversationExportPayload } from '../../agents/session/export.js';
import { redactSecrets } from '../../telemetry/redact.js';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
export const LINEAR_REQUEST_TIMEOUT_MS = 15_000;

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  url: string;
  branchName: string;
  dueDate: string | null;
  updatedAt: string;
  state: { name: string; color: string; type: string };
  team: { name: string; key: string };
  labels: Array<{ name: string; color: string }>;
  project: string | null;
}

export type LinearIssueAvailability = 'disabled' | 'missing_api_key' | 'ready';

export interface LinearIssuesResponse {
  availability: LinearIssueAvailability;
  issues: LinearIssue[];
}

export type LinearTarget =
  | { kind: 'issue'; issueId: string }
  | { kind: 'team'; teamKey: string; title?: string };

export interface LinearPostResult {
  issueId: string;
  issueUrl: string;
  commentUrl: string | null;
  attachmentUrl: string;
}

export interface LinearClient {
  fetchAssignedIssues(options?: { signal?: AbortSignal }): Promise<LinearIssue[]>;
  postConversation(
    target: LinearTarget,
    input: { branch: string; markdown: string; attachment: ConversationExportPayload },
  ): Promise<LinearPostResult>;
}

export interface CreateLinearClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: unknown }>;
}

interface GqlIssueNode extends Omit<LinearIssue, 'labels' | 'project'> {
  labels: { nodes: Array<{ name: string; color: string }> };
  project: { name: string } | null;
}

const ASSIGNED_ISSUES_QUERY = `
  query AssignedIssues {
    viewer {
      assignedIssues(
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
        orderBy: updatedAt
        first: 50
      ) {
        nodes {
          id identifier title description priority priorityLabel url branchName dueDate updatedAt
          state { name color type }
          team { name key }
          labels { nodes { name color } }
          project { name }
        }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query Issue($id: String!) { issue(id: $id) { id identifier title url } }
`;

const TEAM_QUERY = `
  query Team($key: String!) {
    teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key name } }
  }
`;

const VIEWER_QUERY = `query Viewer { viewer { id } }`;

const TEAM_STATES_QUERY = `
  query TeamStates($teamId: String!) {
    team(id: $teamId) { states { nodes { id name type } } }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title url }
    }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation CommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id url }
    }
  }
`;

const FILE_UPLOAD_MUTATION = `
  mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) {
      success
      uploadFile { uploadUrl assetUrl headers { key value } }
    }
  }
`;

const CREATE_ATTACHMENT_MUTATION = `
  mutation AttachmentCreate($issueId: String!, $title: String!, $url: String!, $subtitle: String) {
    attachmentCreate(input: { issueId: $issueId, title: $title, url: $url, subtitle: $subtitle }) {
      success
      attachment { id url }
    }
  }
`;

/** Defense in depth for API/client errors that repeat the credential verbatim. */
export function redactLinearError(error: unknown, apiKey: string | null): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (containsLinearCredential(raw, apiKey)) return '[redacted]';
  return redactSecrets(raw);
}

/** Decode every valid percent-encoded run while leaving malformed escapes intact. */
function decodePercentLayer(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A malformed UTF-8 run must not prevent adjacent ASCII escapes from
      // being inspected. Byte-wise fallback is conservative and still makes
      // progress because each `%XX` shrinks from three characters to one.
      return encoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });
}

/** Detect a credential hidden behind any number of useful percent-encoding layers. */
export function containsLinearCredential(value: string, apiKey: string | null): boolean {
  if (apiKey === null || apiKey === '') return false;
  let current = value;
  // Every useful decoding layer shortens the string, so its initial length is
  // a natural upper bound rather than an arbitrary recursion limit.
  for (let remaining = value.length; remaining >= 0; remaining -= 1) {
    if (current.includes(apiKey)) return true;
    const decoded = decodePercentLayer(current);
    if (decoded === current || decoded.length >= current.length) return false;
    current = decoded;
  }
  return current.includes(apiKey);
}

/** Redact credentials from every string in data received from Linear. */
export function redactLinearPayload<T>(value: T, apiKey: string | null): T {
  if (typeof value === 'string') {
    return (containsLinearCredential(value, apiKey) ? '[redacted]' : redactSecrets(value)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactLinearPayload(entry, apiKey)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactLinearPayload(entry, apiKey)]),
    ) as T;
  }
  return value;
}

function graphqlError(value: GraphqlEnvelope<unknown>, apiKey: string): string | null {
  const messages = (value.errors ?? [])
    .map((error) => (typeof error.message === 'string' ? error.message : 'Linear request failed'))
    .filter(Boolean);
  return messages.length > 0 ? redactLinearError(messages.join('; '), apiKey) : null;
}

function issueFromNode(node: GqlIssueNode): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description,
    priority: node.priority,
    priorityLabel: node.priorityLabel,
    url: node.url,
    branchName: node.branchName,
    dueDate: node.dueDate,
    updatedAt: node.updatedAt,
    state: node.state,
    team: node.team,
    labels: node.labels.nodes,
    project: node.project?.name ?? null,
  };
}

export function branchMatchesLinearIssue(branch: string, issueBranch: string): boolean {
  if (!branch || !issueBranch) return false;
  if (branch === issueBranch) return true;
  const branchSuffix = branch.includes('/') ? branch.slice(branch.lastIndexOf('/') + 1) : branch;
  const issueSuffix = issueBranch.includes('/')
    ? issueBranch.slice(issueBranch.lastIndexOf('/') + 1)
    : issueBranch;
  return branchSuffix === issueSuffix;
}

/**
 * Node/fetch Linear client. The key is captured in a closure, never returned,
 * persisted, logged, or interpolated into an argv string.
 */
export function createLinearClient(options: CreateLinearClientOptions): LinearClient {
  const request = options.fetch ?? globalThis.fetch;
  const apiKey = options.apiKey;
  const timeoutMs = options.timeoutMs ?? LINEAR_REQUEST_TIMEOUT_MS;

  async function graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await request(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: apiKey },
        body: JSON.stringify(variables === undefined ? { query } : { query, variables }),
        signal:
          signal === undefined
            ? AbortSignal.timeout(timeoutMs)
            : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      throw new Error('Linear API is unreachable.');
    }
    if (!response.ok) throw new Error(`Linear API returned HTTP ${response.status}.`);
    const envelope = (await response.json()) as GraphqlEnvelope<T>;
    const error = graphqlError(envelope, apiKey);
    if (error !== null) throw new Error(error);
    if (envelope.data === undefined) throw new Error('Linear API returned no data.');
    return redactLinearPayload(envelope.data, apiKey);
  }

  async function findIssue(
    issueId: string,
  ): Promise<{ id: string; identifier: string; url: string }> {
    const result = await graphql<{
      issue: { id: string; identifier: string; title: string; url: string } | null;
    }>(ISSUE_QUERY, { id: issueId });
    if (result.issue === null)
      throw Object.assign(new Error(`Linear issue not found: ${issueId}`), { status: 404 });
    return result.issue;
  }

  async function createIssue(
    teamKey: string,
    title: string,
    markdown: string,
  ): Promise<{ id: string; identifier: string; url: string }> {
    const teamResult = await graphql<{
      teams: { nodes: Array<{ id: string; key: string; name: string }> };
    }>(TEAM_QUERY, { key: teamKey });
    const team = teamResult.teams.nodes[0];
    if (team === undefined) {
      throw Object.assign(new Error(`Linear team not found: ${teamKey}`), { status: 404 });
    }
    const viewer = await graphql<{ viewer: { id: string } }>(VIEWER_QUERY);
    if (!viewer.viewer.id) throw new Error('Linear viewer lookup returned no id.');
    const stateResult = await graphql<{
      team: { states: { nodes: Array<{ id: string; name: string; type: string }> } } | null;
    }>(TEAM_STATES_QUERY, { teamId: team.id });
    const startedStates = stateResult.team?.states.nodes.filter(
      (state) => state.type === 'started',
    );
    const state =
      startedStates?.find((candidate) => candidate.name.trim().toLowerCase() === 'in progress') ??
      startedStates?.[0];
    if (state === undefined) throw new Error('Linear team has no started workflow state.');
    const result = await graphql<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; title: string; url: string } | null;
      };
    }>(CREATE_ISSUE_MUTATION, {
      input: {
        teamId: team.id,
        title,
        description: markdown,
        assigneeId: viewer.viewer.id,
        stateId: state.id,
      },
    });
    if (!result.issueCreate.success || result.issueCreate.issue === null) {
      throw new Error('Linear issue creation failed.');
    }
    return result.issueCreate.issue;
  }

  async function uploadConversation(
    issueId: string,
    input: { branch: string; markdown: string; attachment: ConversationExportPayload },
  ): Promise<{ assetUrl: string; attachmentUrl: string }> {
    const title = `issue-flow-state:${input.branch}`;
    const payload = `${JSON.stringify(input.attachment, null, 2)}\n`;
    const bytes = Buffer.from(payload, 'utf8');
    const upload = await graphql<{
      fileUpload: {
        success: boolean;
        uploadFile: {
          uploadUrl: string;
          assetUrl: string;
          headers: Array<{ key: string; value: string }>;
        } | null;
      };
    }>(FILE_UPLOAD_MUTATION, {
      contentType: 'application/json',
      filename: `${title.replaceAll('/', '-')}.json`,
      size: bytes.byteLength,
    });
    if (!upload.fileUpload.success || upload.fileUpload.uploadFile === null) {
      throw new Error('Linear file upload initialization failed.');
    }
    const file = upload.fileUpload.uploadFile;
    const uploadUrl = validateLinearUploadUrl(file.uploadUrl, apiKey);
    const headers = Object.fromEntries(file.headers.map((header) => [header.key, header.value]));
    if (!Object.keys(headers).some((header) => header.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    if (
      !Object.keys(headers).some((header) => header.toLowerCase() === 'x-goog-content-length-range')
    ) {
      headers['x-goog-content-length-range'] = `${bytes.byteLength},${bytes.byteLength}`;
    }
    validateLinearUploadHeaders(headers, apiKey);
    let uploaded: Response;
    try {
      uploaded = await request(uploadUrl, {
        method: 'PUT',
        headers,
        body: bytes,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new Error(`Linear attachment upload failed: ${redactLinearError(error, apiKey)}`);
    }
    if (!uploaded.ok) {
      throw new Error(`Linear attachment upload returned HTTP ${uploaded.status}.`);
    }
    const attached = await graphql<{
      attachmentCreate: {
        success: boolean;
        attachment: { id: string; url: string } | null;
      };
    }>(CREATE_ATTACHMENT_MUTATION, {
      issueId,
      title,
      url: file.assetUrl,
      subtitle: `Conversa da branch ${input.branch}`,
    });
    if (!attached.attachmentCreate.success || attached.attachmentCreate.attachment === null) {
      throw new Error('Linear attachment creation failed.');
    }
    return { assetUrl: file.assetUrl, attachmentUrl: attached.attachmentCreate.attachment.url };
  }

  return {
    async fetchAssignedIssues(options = {}) {
      const result = await graphql<{ viewer: { assignedIssues: { nodes: GqlIssueNode[] } } }>(
        ASSIGNED_ISSUES_QUERY,
        undefined,
        options.signal,
      );
      return result.viewer.assignedIssues.nodes.map(issueFromNode);
    },

    async postConversation(target, input) {
      const issue =
        target.kind === 'issue'
          ? await findIssue(target.issueId)
          : await createIssue(
              target.teamKey,
              target.title?.trim() || `Sessão issue-flow: ${input.branch}`,
              `Criado a partir de uma sessão Issue Flow na branch \`${input.branch}\`.`,
            );
      const attachment = await uploadConversation(issue.id, input);
      const summary = [
        `**Issue Flow session — branch \`${input.branch}\`**`,
        '',
        `- Transcript: see attachment \`issue-flow-state:${input.branch}\``,
        `- Agent: ${input.attachment.agent ?? 'unknown'}`,
        `- Base branch: ${input.attachment.baseBranch ?? 'unknown'}`,
        `- Messages: ${input.attachment.conversation.length}`,
        `- Attachment: ${attachment.assetUrl}`,
      ].join('\n');
      let commentUrl: string | null = null;
      try {
        const result = await graphql<{
          commentCreate: { success: boolean; comment: { id: string; url: string } | null };
        }>(CREATE_COMMENT_MUTATION, { issueId: issue.id, body: summary });
        if (result.commentCreate.success && result.commentCreate.comment !== null) {
          commentUrl = result.commentCreate.comment.url;
        }
      } catch {
        // The versioned attachment is the durable export. A summary comment is
        // useful metadata, but its failure must not report that saved data lost.
      }
      return {
        issueId: issue.identifier,
        issueUrl: issue.url,
        commentUrl,
        attachmentUrl: attachment.attachmentUrl,
      };
    },
  };
}

const FORBIDDEN_UPLOAD_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'proxy-authorization',
]);

function validateLinearUploadUrl(raw: string, apiKey = ''): string {
  if (raw === '[redacted]' || containsLinearCredential(raw, apiKey)) {
    throw new Error('Linear returned an untrusted attachment upload URL.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Linear returned an invalid attachment upload URL.');
  }
  const hostname = url.hostname.toLowerCase();
  const googleStorage =
    hostname === 'storage.googleapis.com' || hostname.endsWith('.storage.googleapis.com');
  const containsCredential = containsLinearCredential(url.href, apiKey);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    !googleStorage ||
    containsCredential
  ) {
    throw new Error('Linear returned an untrusted attachment upload URL.');
  }
  return url.toString();
}

function validateLinearUploadHeaders(
  headers: Readonly<Record<string, string>>,
  apiKey: string,
): void {
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      FORBIDDEN_UPLOAD_HEADERS.has(normalized) ||
      name !== name.trim() ||
      /[\r\n]/.test(name) ||
      /[\r\n]/.test(value) ||
      value.includes('[redacted]') ||
      (apiKey !== '' && value.includes(apiKey))
    ) {
      throw new Error('Linear returned unsafe attachment upload headers.');
    }
  }
}
