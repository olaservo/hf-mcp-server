import { z } from 'zod';
import { ModelSearchTool } from './model-search.js';
import { PaperSearchTool } from './paper-search.js';
import { DatasetSearchTool } from './dataset-search.js';
import { ModelDetailTool } from './model-detail.js';
import { DatasetDetailTool } from './dataset-detail.js';
import { PaperSummaryPrompt } from './paper-summary.js';
import {
	MODEL_SEARCH_TOOL_CONFIG,
	PAPER_SEARCH_TOOL_CONFIG,
	DATASET_SEARCH_TOOL_CONFIG
} from './index.js';
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
	private enabledToolIds: string[];

	constructor(hfToken?: string, enabledToolIds: string[] = []) {
		this.modelSearchTool = new ModelSearchTool(hfToken);
		this.paperSearchTool = new PaperSearchTool(hfToken);
		this.datasetSearchTool = new DatasetSearchTool(hfToken);
		this.enabledToolIds = enabledToolIds;
	}

	private getAvailableResourceTypes(): Array<'models' | 'papers' | 'datasets'> {
		const available: Array<'models' | 'papers' | 'datasets'> = [];

		if (this.enabledToolIds.includes(MODEL_SEARCH_TOOL_CONFIG.name)) {
			available.push('models');
		}
		if (this.enabledToolIds.includes(PAPER_SEARCH_TOOL_CONFIG.name)) {
			available.push('papers');
		}
		if (this.enabledToolIds.includes(DATASET_SEARCH_TOOL_CONFIG.name)) {
			available.push('datasets');
		}

		return available;
	}

	public generateDynamicDescription(): string {
		const available = this.getAvailableResourceTypes();

		if (available.length === 0) {
			return 'No research resource types are currently available. Please enable Model Search, Paper Search, or Dataset Search tools.';
		}

		const resourceList = available.map(type => {
			switch(type) {
				case 'models': return '"models" for ML models';
				case 'papers': return '"papers" for research papers';
				case 'datasets': return '"datasets" for training data';
			}
		}).join(', ');

		return `Search across available Hugging Face research resources (${available.join(', ')}). IMPORTANT: Include specific resource type terms in your query - use ${resourceList}. Add descriptive terms like "transformer", "vision", "NLP", "language model" to refine results.`;
	}

	async search(params: DeepResearchSearchParams): Promise<string> {
		const results: DeepResearchSearchResult[] = [];
		const available = this.getAvailableResourceTypes();

		if (available.length === 0) {
			throw new Error('No research resource search tools are currently enabled. Please enable Model Search, Paper Search, or Dataset Search tools.');
		}

		// Distribute results across available resource types
		const limitPerType = Math.max(5, Math.floor(20 / available.length));

		try {
			// Search only across enabled resource types
			const searchPromises: Promise<ToolResult>[] = [];

			if (available.includes('models')) {
				searchPromises.push(
					this.modelSearchTool.searchWithParams({ query: params.query, limit: limitPerType })
						.catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 }))
				);
			}
			if (available.includes('papers')) {
				searchPromises.push(
					this.paperSearchTool.search(params.query, limitPerType)
						.catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 }))
				);
			}
			if (available.includes('datasets')) {
				searchPromises.push(
					this.datasetSearchTool.searchWithParams({ query: params.query, limit: limitPerType })
						.catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 }))
				);
			}

			const searchResults = await Promise.all(searchPromises);

			// Convert and aggregate results based on available types
			let resultIndex = 0;
			if (available.includes('models')) {
				results.push(...this.convertModelSearchResults(searchResults[resultIndex++]));
			}
			if (available.includes('papers')) {
				results.push(...this.convertPaperSearchResults(searchResults[resultIndex++]));
			}
			if (available.includes('datasets')) {
				results.push(...this.convertDatasetSearchResults(searchResults[resultIndex++]));
			}

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
	private enabledToolIds: string[];

	constructor(hfToken?: string, enabledToolIds: string[] = []) {
		this.modelDetailTool = new ModelDetailTool(hfToken);
		this.datasetDetailTool = new DatasetDetailTool(hfToken);
		this.paperSummaryTool = new PaperSummaryPrompt(hfToken);
		this.enabledToolIds = enabledToolIds;
	}

	private getAvailableResourceTypes(): Array<'models' | 'papers' | 'datasets'> {
		const available: Array<'models' | 'papers' | 'datasets'> = [];

		// Check if underlying search tools are enabled (they're needed for the same resource types)
		if (this.enabledToolIds.includes(MODEL_SEARCH_TOOL_CONFIG.name)) {
			available.push('models');
		}
		if (this.enabledToolIds.includes(PAPER_SEARCH_TOOL_CONFIG.name)) {
			available.push('papers');
		}
		if (this.enabledToolIds.includes(DATASET_SEARCH_TOOL_CONFIG.name)) {
			available.push('datasets');
		}

		return available;
	}

	public generateDynamicDescription(): string {
		const available = this.getAvailableResourceTypes();

		if (available.length === 0) {
			return 'No research resource types are currently available for fetching. Please enable Model Search, Paper Search, or Dataset Search tools.';
		}

		const examples: string[] = [];
		if (available.includes('models')) examples.push('models (author/model-name)');
		if (available.includes('datasets')) examples.push('datasets (author/dataset-name)');
		if (available.includes('papers')) examples.push('papers (arXiv IDs like 2301.12345)');

		return `Fetch detailed content from available Hugging Face research resources. Supports ${examples.join(', ')}. Provide exact resource identifiers or URLs.`;
	}

	async fetch(params: DeepResearchFetchParams): Promise<string> {
		try {
			const id = params.id;
			const available = this.getAvailableResourceTypes();

			if (available.length === 0) {
				throw new Error('No research resource fetch capabilities are currently enabled. Please enable Model Search, Paper Search, or Dataset Search tools.');
			}

			// Determine resource type from ID/URL and fetch accordingly
			const resourceType = this.determineResourceType(id);

			switch (resourceType) {
				case 'model':
					if (!available.includes('models')) {
						throw new Error('Model fetching is not available. Model Search tool is not enabled.');
					}
					return this.fetchModel(id);

				case 'dataset':
					if (!available.includes('datasets')) {
						throw new Error('Dataset fetching is not available. Dataset Search tool is not enabled.');
					}
					return this.fetchDataset(id);

				case 'paper':
					if (!available.includes('papers')) {
						throw new Error('Paper fetching is not available. Paper Search tool is not enabled.');
					}
					return this.fetchPaper(id);

				default:
					const supportedFormats = [];
					if (available.includes('models')) supportedFormats.push('- Models: author/model-name or https://huggingface.co/author/model-name');
					if (available.includes('datasets')) supportedFormats.push('- Datasets: author/dataset-name or https://huggingface.co/datasets/author/dataset-name');
					if (available.includes('papers')) supportedFormats.push('- Papers: 2301.12345 or https://arxiv.org/abs/2301.12345 or https://huggingface.co/papers/2301.12345');

					const formatsText = supportedFormats.length > 0 ? supportedFormats.join('\n') : 'No resource types are currently available.';
					throw new Error(`Unable to determine resource type for "${id}". Please provide a more specific URL or ID format.\n\nCurrently supported formats:\n${formatsText}`);
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