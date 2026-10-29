import { hash, requireThat } from './util.mjs';

// References identify actual completed tool results, not model-written summaries.
export function nativeEvidence(messages) {
  return messages.filter(message => message.type === 'assistant').flatMap(message =>
    (message.content ?? []).filter(part => part.type === 'tool' && part.state?.status === 'completed' &&
      !part.name.startsWith('prometheus_')).map(part => ({
      messageID: message.id, toolCallID: part.id, tool: part.name,
      input: part.state.input, content: part.state.content, metadata: part.state.metadata ?? {},
      hash: hash({ input: part.state.input, content: part.state.content, metadata: part.state.metadata ?? {} }),
    })));
}

export function selectEvidence(messages, references) {
  requireThat(Array.isArray(references), 'Supply native tool-result references.');
  const available = nativeEvidence(messages);
  return references.map(reference => {
    const evidence = available.find(item => item.messageID === reference.messageID && item.toolCallID === reference.toolCallID);
    requireThat(evidence, 'Evidence must identify a completed native tool result in this evaluator session.', 'evidence');
    return evidence;
  });
}
