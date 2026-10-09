/**
 * Сборка полного анализа: эвристика + необязательное дополнение модели + черновик.
 *
 * Модель может только дополнить резюме и вопросы. Факты, риски, цена, срок и
 * черновик формируются детерминированно на стороне приложения.
 */

import { analyzeJob } from './analyzer.js';
import { createTexts } from '../texts/texts.js';
import { estimateRate } from './rate-estimator.js';
import { buildProposalDraft } from './proposal-draft.js';

export async function analyzeAndDraft(job, profile, { modelAdapter = null, config = {}, texts = null } = {}) {
  // Тексты создаются один раз на процесс и переиспользуются всеми слоями.
  const textsObject = texts ?? createTexts({ rootDir: config.rootDir ?? process.cwd() });
  const analysis = analyzeJob(job, profile, { ...config, texts: textsObject });

  let modelNotes = null;
  if (modelAdapter) {
    // Selective-режим экономит бесплатную квоту: понятные задания модель не трогает.
    const shouldEnrich =
      typeof modelAdapter.shouldEnrich !== 'function' || modelAdapter.shouldEnrich(job, analysis);
    const enrichment = shouldEnrich ? await modelAdapter.enrich(job, analysis, profile) : null;
    if (enrichment) {
      modelNotes = {
        provider: enrichment.provider,
        summary: enrichment.summary,
        notes: enrichment.notes,
        extraQuestions: enrichment.extraQuestions
      };
      if (enrichment.extraQuestions?.length > 0) {
        const merged = [...analysis.questions];
        for (const question of enrichment.extraQuestions) {
          if (!merged.includes(question)) merged.push(question);
        }
        analysis.questions = merged;
      }
      analysis.inferences.modelSummary = enrichment.summary;
      analysis.inferences.modelNotes = enrichment.notes;
    }
  }

  // Оценка по ставке профиля: нужна и черновику, и сообщению.
  const rate = estimateRate(job, profile, { texts: textsObject });
  const analysisWithRate = { ...analysis, rate };

  const draft = buildProposalDraft(job, analysisWithRate, profile, { texts: textsObject });
  return {
    ...analysisWithRate,
    draft,
    texts: textsObject,
    modelNotes,
    modelUsed: Boolean(modelNotes),
    // Явное разделение источников для сообщения и логов.
    sections: {
      facts: analysis.facts,
      inferences: analysis.inferences,
      unknown: analysis.unknown,
      factsSource: textsObject.t('analysis.sources.factsCard'),
      inferencesSource: modelNotes
        ? textsObject.t('analysis.sources.inferencesWithModel', { provider: modelNotes.provider })
        : textsObject.t('analysis.sources.inferencesHeuristic')
    }
  };
}
