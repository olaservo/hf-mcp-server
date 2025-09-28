import { z } from 'zod';
import { ModelSearchTool } from './model-search.js';
import { PaperSearchTool } from './paper-search.js';
import { DatasetSearchTool } from './dataset-search.js';
import { ModelDetailTool } from './model-detail.js';
import { DatasetDetailTool } from './dataset-detail.js';
import { PaperSummaryPrompt } from './paper-summary.js';
import type { ToolResult } from './types/tool-result.js';

// ChatGPT Deep Research compatible search tool
export const DEEP_RESEARCH_SEARCH_CONFIG = {
	name: 'search',
	description: 'Search across Hugging Face research resources (models, papers, datasets only). IMPORTANT: Include specific resource type terms in your query - use "models" or "model" for ML models, "papers" or "paper" for research papers, "datasets" or "dataset" for training data. Add descriptive terms like "transformer", "vision", "NLP", "language model" to refine results.',
	schema: z.object({
		query: z.string().min(1).describe('Search query - MUST include resource type keywords ("models", "papers", "datasets") and descriptive terms for best results'),
	}),
	annotations: {
		title: 'Unified Search for Deep Research',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
} as const;

// ChatGPT Deep Research compatible fetch tool
export const DEEP_RESEARCH_FETCH_CONFIG = {
	name: 'fetch',
	description: 'Fetch detailed content from Hugging Face research resources. Supports models (author/model-name), datasets (author/dataset-name), and papers (arXiv IDs like 2301.12345). Provide exact resource identifiers or URLs.',
	schema: z.object({
		id: z.string().describe('Resource ID to fetch'),
	}),
	annotations: {
		title: 'Fetch Resource for Deep Research',
		destructiveHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
} as const;

export type DeepResearchSearchParams = z.infer<typeof DEEP_RESEARCH_SEARCH_CONFIG.schema>;
export type DeepResearchFetchParams = z.infer<typeof DEEP_RESEARCH_FETCH_CONFIG.schema>;

interface DeepResearchSearchResult {
	id: string;
	title: string;
	url: string;
}

interface DeepResearchDocument {
	id: string;
	title: string;
	text: string;
	url: string;
	metadata?: Record<string, any>;
}

export class DeepResearchSearchTool {
	private modelSearchTool: ModelSearchTool;
	private paperSearchTool: PaperSearchTool;
	private datasetSearchTool: DatasetSearchTool;

	constructor(hfToken?: string) {
		this.modelSearchTool = new ModelSearchTool(hfToken);
		this.paperSearchTool = new PaperSearchTool(hfToken);
		this.datasetSearchTool = new DatasetSearchTool(hfToken);
	}

	async search(params: DeepResearchSearchParams): Promise<string> {
		const results: DeepResearchSearchResult[] = [];
		const limitPerType = 7; // Distribute results across 3 resource types

		try {
			// Search across core research resource types
			const [modelResults, paperResults, datasetResults] = await Promise.all([
				this.modelSearchTool.searchWithParams({ query: params.query, limit: limitPerType }).catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 })),
				this.paperSearchTool.search(params.query, limitPerType).catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 })),
				this.datasetSearchTool.searchWithParams({ query: params.query, limit: limitPerType }).catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 }))
			]);

			// Convert and aggregate results
			results.push(...this.convertModelSearchResults(modelResults));
			results.push(...this.convertPaperSearchResults(paperResults));
			results.push(...this.convertDatasetSearchResults(datasetResults));

			const response = {
				results: results
			};

			return JSON.stringify(response);
		} catch (error) {
			throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}


	private convertModelSearchResults(toolResult: ToolResult): DeepResearchSearchResult[] {
		const results: DeepResearchSearchResult[] = [];
		const lines = toolResult.formatted.split('\n');

		for (const line of lines) {
			// Look for model links in format [model-name](https://huggingface.co/...)
			const linkMatch = line.match(/\[([^\]]+)\]\((https:\/\/huggingface\.co\/[^)]+)\)/);
			if (linkMatch && linkMatch[1] && linkMatch[2]) {
				const title = linkMatch[1];
				const url = linkMatch[2];
				const id = url.split('/').slice(-1)[0] || title;

				results.push({
					id,
					title: title.trim(),
					url: url.trim()
				});
			}
		}

		return results;
	}

	private convertPaperSearchResults(toolResult: ToolResult): DeepResearchSearchResult[] {
		const results: DeepResearchSearchResult[] = [];
		const lines = toolResult.formatted.split('\n');

		for (const line of lines) {
			// Look for paper links
			const linkMatch = line.match(/\[([^\]]+)\]\((https:\/\/huggingface\.co\/papers\/[^)]+)\)/);
			if (linkMatch && linkMatch[1] && linkMatch[2]) {
				const title = linkMatch[1];
				const url = linkMatch[2];
				const id = url.split('/').slice(-1)[0] || title;

				results.push({
					id,
					title: title.trim(),
					url: url.trim()
				});
			}
		}

		return results;
	}


	private convertDatasetSearchResults(toolResult: ToolResult): DeepResearchSearchResult[] {
		const results: DeepResearchSearchResult[] = [];
		const lines = toolResult.formatted.split('\n');

		for (const line of lines) {
			// Look for dataset links
			const linkMatch = line.match(/\[([^\]]+)\]\((https:\/\/huggingface\.co\/datasets\/[^)]+)\)/);
			if (linkMatch && linkMatch[1] && linkMatch[2]) {
				const title = linkMatch[1];
				const url = linkMatch[2];
				const id = url.split('/').slice(-1)[0] || title; // Use dataset name as ID
				results.push({
					id,
					title: title.trim(),
					url: url.trim()
				});
			}
		}

		return results;
	}
}

export class DeepResearchFetchTool {
	private modelDetailTool: ModelDetailTool;
	private datasetDetailTool: DatasetDetailTool;
	private paperSummaryTool: PaperSummaryPrompt;

	constructor(hfToken?: string) {
		this.modelDetailTool = new ModelDetailTool(hfToken);
		this.datasetDetailTool = new DatasetDetailTool(hfToken);
		this.paperSummaryTool = new PaperSummaryPrompt(hfToken);
	}

	async fetch(params: DeepResearchFetchParams): Promise<string> {
		try {
			const id = params.id;

			// Determine resource type from ID/URL and fetch accordingly
			const resourceType = this.determineResourceType(id);

			switch (resourceType) {
				case 'model':
					return this.fetchModel(id);

				case 'dataset':
					return this.fetchDataset(id);

				case 'paper':
					return this.fetchPaper(id);

				default:
					// Try to infer from the ID format if no URL was provided
					return this.fetchUnknownResource(id);
			}
		} catch (error) {
			throw new Error(`Fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	private determineResourceType(id: string): 'model' | 'dataset' | 'paper' | 'unknown' {
		// Model URLs
		if (id.includes('huggingface.co/') && !id.includes('/datasets/') && !id.includes('/papers/')) {
			return 'model';
		}

		// Dataset URLs
		if (id.includes('huggingface.co/datasets/')) {
			return 'dataset';
		}

		// Paper URLs
		if (id.includes('huggingface.co/papers/') || id.includes('arxiv.org') || id.match(/^\d{4}\.\d{4,5}$/)) {
			return 'paper';
		}

		return 'unknown';
	}


	private async fetchModel(id: string): Promise<string> {
		// Extract model ID from URL if it's a URL
		const modelId = id.includes('huggingface.co/') ?
			id.split('huggingface.co/')[1]?.split('?')[0] || id : id;

		const result = await this.modelDetailTool.getDetails(modelId, true);

		// Extract metadata from the formatted result for cross-references
		const crossRefs = this.extractCrossReferences(result.formatted, 'model');

		const document: DeepResearchDocument = {
			id: modelId,
			title: `Model: ${modelId}`,
			text: result.formatted,
			url: `https://huggingface.co/${modelId}`,
			metadata: {
				type: 'model',
				source: 'huggingface',
				totalResults: result.totalResults,
				resultsShared: result.resultsShared,
				...crossRefs
			}
		};

		return JSON.stringify(document);
	}

	private async fetchDataset(id: string): Promise<string> {
		// Extract dataset ID from URL if it's a URL
		const datasetId = id.includes('huggingface.co/datasets/') ?
			id.split('datasets/')[1]?.split('?')[0] || id : id;

		const result = await this.datasetDetailTool.getDetails(datasetId, true);

		// Extract metadata from the formatted result for cross-references
		const crossRefs = this.extractCrossReferences(result.formatted, 'dataset');

		const document: DeepResearchDocument = {
			id: datasetId,
			title: `Dataset: ${datasetId}`,
			text: result.formatted,
			url: `https://huggingface.co/datasets/${datasetId}`,
			metadata: {
				type: 'dataset',
				source: 'huggingface',
				totalResults: result.totalResults,
				resultsShared: result.resultsShared,
				...crossRefs
			}
		};

		return JSON.stringify(document);
	}

	private async fetchPaper(id: string): Promise<string> {
		// Extract arXiv ID from various formats
		let arxivId = id;
		if (id.includes('arxiv.org')) {
			arxivId = id.split('/abs/')[1] || id.split('/')[id.split('/').length - 1] || id;
		}
		if (id.includes('huggingface.co/papers/')) {
			arxivId = id.split('papers/')[1]?.split('?')[0] || id;
		}

		const content = await this.paperSummaryTool.generateSummary({ paper_id: arxivId });

		const document: DeepResearchDocument = {
			id: arxivId,
			title: `Paper: ${arxivId}`,
			text: content,
			url: `https://arxiv.org/abs/${arxivId}`,
			metadata: {
				type: 'paper',
				source: 'arxiv'
			}
		};

		return JSON.stringify(document);
	}


	private async fetchUnknownResource(id: string): Promise<string> {
		// Try to infer the resource type based on ID format

		// Check if it looks like a model ID (author/model format)
		if (id.includes('/') && !id.includes(' ') && id.split('/').length === 2) {
			try {
				return await this.fetchModel(id);
			} catch {
				// If model fetch fails, try dataset
				try {
					return await this.fetchDataset(id);
				} catch {
					// Fall through to unsupported
				}
			}
		}

		// Check if it looks like an arXiv ID
		if (id.match(/^\d{4}\.\d{4,5}$/)) {
			try {
				return await this.fetchPaper(id);
			} catch {
				// Fall through to unsupported
			}
		}

		// Unsupported resource type
		const document: DeepResearchDocument = {
			id: id,
			title: `Resource: ${id}`,
			text: `This resource (${id}) could not be automatically identified. Please provide a more specific URL or ID format.

Supported formats:
- Models: author/model-name or https://huggingface.co/author/model-name
- Datasets: author/dataset-name or https://huggingface.co/datasets/author/dataset-name
- Papers: 2301.12345 or https://arxiv.org/abs/2301.12345 or https://huggingface.co/papers/2301.12345`,
			url: id.startsWith('http') ? id : `https://huggingface.co/${id}`,
			metadata: {
				type: 'unsupported',
				source: 'huggingface'
			}
		};

		return JSON.stringify(document);
	}


	private extractCrossReferences(content: string, resourceType: string): Record<string, any> {
		const crossRefs: Record<string, any> = {};

		// Extract paper references (arXiv IDs)
		const paperMatches = content.match(/\b((?:19|20)\d{2}\.\d{4,5})\b/g);
		if (paperMatches) {
			crossRefs.related_papers = [...new Set(paperMatches)].slice(0, 3);
		}

		// Extract model references (author/model format)
		const modelMatches = content.match(/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/g);
		if (modelMatches && resourceType !== 'model') {
			crossRefs.related_models = [...new Set(modelMatches)]
				.filter(ref => !ref.includes('.') || ref.includes('-'))
				.slice(0, 3);
		}

		// Extract tags from content
		const tagMatches = content.match(/#([a-zA-Z0-9_-]+)/g);
		if (tagMatches) {
			crossRefs.tags = [...new Set(tagMatches.map(tag => tag.substring(1)))].slice(0, 5);
		}

		// Extract license information
		const licenseMatch = content.match(/license[:\s]+([a-zA-Z0-9\s-]+)/i);
		if (licenseMatch && licenseMatch[1]) {
			crossRefs.license = licenseMatch[1].trim();
		}

		// Extract download/like counts if present
		const downloadMatch = content.match(/(\d+(?:\.\d+)?[KMB]?)\s*downloads?/i);
		const likeMatch = content.match(/(\d+(?:\.\d+)?[KMB]?)\s*likes?/i);
		if (downloadMatch && downloadMatch[1]) crossRefs.downloads = downloadMatch[1];
		if (likeMatch && likeMatch[1]) crossRefs.likes = likeMatch[1];

		return crossRefs;
	}
}