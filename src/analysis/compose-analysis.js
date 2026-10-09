/**
 * Сборка полного анализа: эвристика + необязательное дополнение модели + черновик.
 *
 * Модель дополняет анализ (вердикт, вопросы, условия, черновик, резюме, заметки),
 * но не меняет факты, риски и цену — они детерминированны. Черновик готовится
 * только для «подходит»/«возможно»; для «не подходит» и «нужно уточнить» отклик
 * не пишется вовсе.
 */

import { analyzeJob } from './analyzer.js';
import { createTexts } from '../texts/texts.js';
import { estimateRate } from './rate-estimator.js';
import { buildProposalDraft } from './proposal-draft.js';

/** Риски, которые модель не может перекрыть своим вердиктом (жёсткая безопасность). */
const HARD_BLOCKING_CODES = new Set(['excluded_work', 'backend_requested']);

export async function analyzeAndDraft(job, profile, { modelAdapter = null, config = {}, texts = null } = {}) {
  // Тексты создаются один раз на процесс и переиспользуются всеми слоями.
  const textsObject = texts ?? createTexts({ rootDir: config.rootDir ?? process.cwd() });
  const analysis = analyzeJob(job, profile, { ...config, texts: textsObject });

  let modelNotes = null;
  let modelDraft = null;
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
        questions: enrichment.questions,
        conditions: enrichment.conditions,
        verdict: enrichment.verdict
      };
      // Оценка задания моделью: может уточнить эвристический вердикт, но не перекрывает
      // жёсткие блокирующие риски (исключённая работа, backend) — их не «поднять» до «подходит».
      if (enrichment.verdict) {
        const hardBlocking = analysis.risks.some(
          (risk) => HARD_BLOCKING_CODES.has(risk.code) || (risk.code === 'budget_below_minimum' && analysis.budget?.belowMinimum)
        );
        if (!hardBlocking || enrichment.verdict === 'не подходит' || enrichment.verdict === 'нужно уточнить') {
          analysis.verdict = enrichment.verdict;
          analysis.verdictLabel = enrichment.verdict;
        }
      }
      // Вопросы заказчику и предварительные условия модель составляет сама.
      if (enrichment.questions?.length > 0) analysis.questions = enrichment.questions;
      if (enrichment.conditions?.length > 0) analysis.conditions = enrichment.conditions;
      modelDraft = enrichment.draft;
      analysis.inferences.modelSummary = enrichment.summary;
      analysis.inferences.modelNotes = enrichment.notes;
    }
  }

  // Оценка по ставке профиля: нужна и черновику, и сообщению.
  const rate = estimateRate(job, profile, { texts: textsObject });
  const analysisWithRate = { ...analysis, rate };

  // Черновик готовим только для «подходит»/«возможно». Для «не подходит» и
  // «нужно уточнить» отклик не пишем вовсе.
  const draftable = analysisWithRate.verdict === 'подходит' || analysisWithRate.verdict === 'возможно';
  let draft = null;
  if (draftable) {
    draft = modelDraft
      ? { text: modelDraft, assumptions: analysisWithRate.assumptions ?? [] }
      : buildProposalDraft(job, analysisWithRate, profile, { texts: textsObject });
  }

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
