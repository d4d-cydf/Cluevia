import type { DocumentLanguage } from '@/lib/document-language';
import { localizeHref } from '@/lib/document-language';
import defaultComponents from 'fumadocs-ui/mdx';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Callout } from 'fumadocs-ui/components/callout';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import { Abstract, Equation, ResearchPipeline } from '@/components/research';
import { ResearchDiagram, ResearchPlot, CandidateMatrix, EventIntervals, ResultMatrix } from '@/components/research-figures';
import { SupportExplorer, WitnessExplorer } from '@/components/research-explorers';

export function getMDXComponents(components?: MDXComponents, language: DocumentLanguage = 'ko'): MDXComponents {
  const Anchor = defaultComponents.a ?? 'a';
  return { ...defaultComponents, a: (props: ComponentProps<'a'>) => <Anchor {...props} href={props.href ? localizeHref(props.href, language) : props.href} />, code: (props: ComponentProps<'code'>) => <code {...props} className={`${props.className || ''} notranslate`} translate="no" />, Card: (props: ComponentProps<typeof Card>) => <Card {...props} href={props.href ? localizeHref(props.href, language) : props.href} />, Cards, Callout, Step, Steps, Tab, Tabs,
    Abstract: props => <Abstract {...props} language={language} />,
    Equation: props => <Equation {...props} language={language} />,
    ResearchPipeline: () => <ResearchPipeline language={language} />,
    ResearchDiagram: props => <ResearchDiagram {...props} language={language} />,
    ResearchPlot: props => <ResearchPlot {...props} language={language} />,
    CandidateMatrix: props => <CandidateMatrix {...props} language={language} />,
    EventIntervals: props => <EventIntervals {...props} language={language} />,
    ResultMatrix: props => <ResultMatrix {...props} language={language} />,
    SupportExplorer: props => <SupportExplorer {...props} language={language} />,
    WitnessExplorer: props => <WitnessExplorer {...props} language={language} />,
    ...components };
}
