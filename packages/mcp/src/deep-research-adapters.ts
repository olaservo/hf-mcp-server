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
import { modelInfo, datasetInfo } from '@huggingface/hub';
import { formatNumber } from './utilities.js';
import { fetchReadmeContent } from './readme-utils.js';

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
			// Search only across enabled resource types and collect results
			const searchTasks: Array<{ type: 'models' | 'papers' | 'datasets', promise: Promise<ToolResult> }> = [];

			if (available.includes('models')) {
				searchTasks.push({
					type: 'models',
					promise: this.modelSearchTool.searchWithParams({ query: params.query, limit: limitPerType })
						.catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 }))
				});
			}
			if (available.includes('papers')) {
				searchTasks.push({
					type: 'papers',
					promise: this.paperSearchTool.search(params.query, limitPerType)
						.catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 }))
				});
			}
			if (available.includes('datasets')) {
				searchTasks.push({
					type: 'datasets',
					promise: this.datasetSearchTool.searchWithParams({ query: params.query, limit: limitPerType })
						.catch(() => ({ formatted: '', totalResults: 0, resultsShared: 0 }))
				});
			}

			const searchResults = await Promise.all(searchTasks.map(task => task.promise));

			// Convert and aggregate results based on actual task order
			for (let i = 0; i < searchTasks.length; i++) {
				const task = searchTasks[i];
				const result = searchResults[i];

				if (task && result) {
					switch (task.type) {
						case 'models':
							results.push(...this.convertModelSearchResults(result));
							break;
						case 'papers':
							results.push(...this.convertPaperSearchResults(result));
							break;
						case 'datasets':
							results.push(...this.convertDatasetSearchResults(result));
							break;
					}
				}
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
	private hfToken?: string;

	constructor(hfToken?: string, enabledToolIds: string[] = []) {
		this.modelDetailTool = new ModelDetailTool(hfToken);
		this.datasetDetailTool = new DatasetDetailTool(hfToken);
		this.paperSummaryTool = new PaperSummaryPrompt(hfToken);
		this.enabledToolIds = enabledToolIds;
		this.hfToken = hfToken;
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

		// Get both structured data and formatted result
		const [modelData, result] = await Promise.all([
			this.getModelStructuredData(modelId),
			this.modelDetailTool.getDetails(modelId, true)
		]);

		// Extract metadata from structured API data (much more reliable)
		let crossRefs = this.extractModelCrossReferences(modelData);

		// Enrich with YAML frontmatter if API data is incomplete
		crossRefs = await this.enrichWithYamlFrontmatter(crossRefs, modelId, 'models');

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

		// Get both structured data and formatted result
		const [datasetData, result] = await Promise.all([
			this.getDatasetStructuredData(datasetId),
			this.datasetDetailTool.getDetails(datasetId, true)
		]);

		// Extract metadata from structured API data (much more reliable)
		let crossRefs = this.extractDatasetCrossReferences(datasetData);

		// Enrich with YAML frontmatter if API data is incomplete
		crossRefs = await this.enrichWithYamlFrontmatter(crossRefs, datasetId, 'datasets');

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




	/**
	 * Get structured model data directly from Hugging Face API
	 */
	private async getModelStructuredData(modelId: string): Promise<any> {
		try {
			const additionalFields = [
				'author',
				'downloadsAllTime',
				'library_name',
				'tags',
				'cardData',
				'spaces'
			] as const;

			return await modelInfo<(typeof additionalFields)[number]>({
				name: modelId,
				additionalFields: Array.from(additionalFields),
				...(this.hfToken && {
					credentials: { accessToken: this.hfToken }
				})
			});
		} catch (error) {
			console.warn(`Failed to get structured model data for ${modelId}:`, error);
			return null;
		}
	}

	/**
	 * Get structured dataset data directly from Hugging Face API
	 */
	private async getDatasetStructuredData(datasetId: string): Promise<any> {
		try {
			const additionalFields = [
				'author',
				'downloadsAllTime',
				'tags',
				'description',
				'cardData'
			] as const;

			return await datasetInfo<(typeof additionalFields)[number]>({
				name: datasetId,
				additionalFields: Array.from(additionalFields),
				...(this.hfToken && {
					credentials: { accessToken: this.hfToken }
				})
			});
		} catch (error) {
			console.warn(`Failed to get structured dataset data for ${datasetId}:`, error);
			return null;
		}
	}

	/**
	 * Extract cross-references from structured model data
	 */
	private extractModelCrossReferences(modelData: any): Record<string, any> {
		const crossRefs: Record<string, any> = {};

		if (!modelData) return crossRefs;

		// Use structured tags (much more reliable than regex)
		if (modelData.tags && Array.isArray(modelData.tags)) {
			crossRefs.tags = modelData.tags.slice(0, 5);
		}

		// Use structured cardData for metadata
		if (modelData.cardData) {
			const cardData = modelData.cardData;

			// License from structured data
			if (cardData.license) {
				crossRefs.license = Array.isArray(cardData.license)
					? cardData.license.join(', ')
					: cardData.license;
			}

			// Related datasets from structured data
			if (cardData.datasets) {
				crossRefs.related_datasets = Array.isArray(cardData.datasets)
					? cardData.datasets.slice(0, 3)
					: [cardData.datasets];
			}

			// Fine-tuned from (related model)
			if (cardData.finetuned_from) {
				crossRefs.related_models = [cardData.finetuned_from];
			}
		}

		// Use structured stats (exact numbers, not regex-parsed)
		if (modelData.downloadsAllTime) {
			crossRefs.downloads = formatNumber(modelData.downloadsAllTime);
		}
		if (modelData.likes) {
			crossRefs.likes = modelData.likes.toString();
		}

		// Related spaces from structured data
		if (modelData.spaces && Array.isArray(modelData.spaces) && modelData.spaces.length > 0) {
			crossRefs.related_spaces = modelData.spaces.slice(0, 3);
		}

		return crossRefs;
	}

	/**
	 * Extract cross-references from structured dataset data
	 */
	private extractDatasetCrossReferences(datasetData: any): Record<string, any> {
		const crossRefs: Record<string, any> = {};

		if (!datasetData) return crossRefs;

		// Use structured tags
		if (datasetData.tags && Array.isArray(datasetData.tags)) {
			crossRefs.tags = datasetData.tags.slice(0, 5);
		}

		// Use structured cardData for metadata
		if (datasetData.cardData) {
			const cardData = datasetData.cardData;

			// License from structured data
			if (cardData.license) {
				crossRefs.license = Array.isArray(cardData.license)
					? cardData.license.join(', ')
					: cardData.license;
			}

			// Task categories
			if (cardData.task_categories) {
				crossRefs.task_categories = Array.isArray(cardData.task_categories)
					? cardData.task_categories
					: [cardData.task_categories];
			}

			// Size categories
			if (cardData.size_categories) {
				crossRefs.size_categories = Array.isArray(cardData.size_categories)
					? cardData.size_categories
					: [cardData.size_categories];
			}

			// Language information
			if (cardData.language) {
				crossRefs.language = Array.isArray(cardData.language)
					? cardData.language
					: [cardData.language];
			}
		}

		// Use structured stats
		if (datasetData.downloadsAllTime) {
			crossRefs.downloads = formatNumber(datasetData.downloadsAllTime);
		}
		if (datasetData.likes) {
			crossRefs.likes = datasetData.likes.toString();
		}

		return crossRefs;
	}

	/**
	 * Parse YAML frontmatter from README content as fallback for missing API data
	 */
	private async enrichWithYamlFrontmatter(
		crossRefs: Record<string, any>,
		resourceId: string,
		resourceType: 'models' | 'datasets'
	): Promise<Record<string, any>> {
		try {
			// Fetch README with YAML frontmatter preserved
			const readmeWithYaml = await fetchReadmeContent(resourceId, resourceType, true);
			if (!readmeWithYaml) return crossRefs;

			// Extract YAML frontmatter
			const yamlData = this.parseYamlFrontmatter(readmeWithYaml);
			if (!yamlData) return crossRefs;

			// Merge YAML data with existing cross-references (API data takes precedence)
			const enrichedRefs = { ...crossRefs };

			// Add tags if not already present from API
			if (!enrichedRefs.tags && yamlData.tags) {
				enrichedRefs.tags = Array.isArray(yamlData.tags) ? yamlData.tags : [yamlData.tags];
			}

			// Add license if not already present
			if (!enrichedRefs.license && yamlData.license) {
				enrichedRefs.license = yamlData.license;
			}

			// Add language info if not already present
			if (!enrichedRefs.language && yamlData.language) {
				enrichedRefs.language = Array.isArray(yamlData.language) ? yamlData.language : [yamlData.language];
			}

			// For models: add base_model or finetuned_from as related models
			if (resourceType === 'models') {
				if (!enrichedRefs.related_models && (yamlData.base_model || yamlData.finetuned_from)) {
					enrichedRefs.related_models = [yamlData.base_model || yamlData.finetuned_from];
				}

				// Add datasets if not already present
				if (!enrichedRefs.related_datasets && yamlData.datasets) {
					enrichedRefs.related_datasets = Array.isArray(yamlData.datasets)
						? yamlData.datasets.slice(0, 3)
						: [yamlData.datasets];
				}
			}

			// For datasets: add task categories and size categories if not present
			if (resourceType === 'datasets') {
				if (!enrichedRefs.task_categories && yamlData.task_categories) {
					enrichedRefs.task_categories = Array.isArray(yamlData.task_categories)
						? yamlData.task_categories
						: [yamlData.task_categories];
				}

				if (!enrichedRefs.size_categories && yamlData.size_categories) {
					enrichedRefs.size_categories = Array.isArray(yamlData.size_categories)
						? yamlData.size_categories
						: [yamlData.size_categories];
				}
			}

			return enrichedRefs;
		} catch (error) {
			console.warn(`Failed to enrich with YAML frontmatter for ${resourceId}:`, error);
			return crossRefs;
		}
	}

	/**
	 * Parse YAML frontmatter from markdown content
	 */
	private parseYamlFrontmatter(content: string): Record<string, any> | null {
		try {
			// Match YAML frontmatter: starts with ---, ends with ---
			const yamlPattern = /^(\s*---[\r\n]+)([\S\s]*?)([\r\n]+---(\r\n|\n|$))/;
			const match = content.match(yamlPattern);

			if (!match || !match[2]) return null;

			const yamlContent = match[2].trim();

			// Simple YAML parser for common key-value patterns
			// This is basic but should handle most model card YAML
			const yamlData: Record<string, any> = {};
			const lines = yamlContent.split('\n');

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;

				// Handle key: value pairs
				const keyValueMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
				if (keyValueMatch && keyValueMatch[1] && keyValueMatch[2] !== undefined) {
					const key = keyValueMatch[1].trim();
					let value: string | string[] = keyValueMatch[2].trim();

					// Handle arrays (simple format: [item1, item2] or - item)
					if (value.startsWith('[') && value.endsWith(']')) {
						value = value.slice(1, -1).split(',').map(v => v.trim().replace(/['"]/g, ''));
					} else if (value.startsWith('"') && value.endsWith('"')) {
						value = value.slice(1, -1);
					} else if (value.startsWith("'") && value.endsWith("'")) {
						value = value.slice(1, -1);
					}

					yamlData[key] = value;
				}
			}

			return Object.keys(yamlData).length > 0 ? yamlData : null;
		} catch (error) {
			console.warn('Failed to parse YAML frontmatter:', error);
			return null;
		}
	}
}