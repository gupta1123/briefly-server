import BaseAgent from './base-agent.js';

class ResumeAgent extends BaseAgent {
  constructor(agentConfig) {
    super(agentConfig);
  }

  /**
   * Filter documents for resume/CV content
   */
  async filterRelevantDocuments(documents) {
    return documents.filter(doc => {
      const title = (doc.title || doc.name || '').toLowerCase();
      const type = (doc.documentType || doc.type || '').toLowerCase();
      const category = (doc.category || '').toLowerCase();
      const content = (doc.content || '').toLowerCase();

      // Resume/CV indicators
      const resumeKeywords = [
        'resume', 'cv', 'curriculum', 'vitae', 'profile', 'candidate',
        'experience', 'qualification', 'education', 'skill', 'work history',
        'employment', 'career', 'professional', 'background'
      ];

      // Check title and type
      const hasResumeTitle = resumeKeywords.some(keyword =>
        title.includes(keyword) || type.includes(keyword) || category.includes(keyword)
      );

      // Check content for resume patterns
      const hasResumeContent = content &&
        (content.includes('experience') ||
         content.includes('education') ||
         content.includes('skills') ||
         content.includes('qualification') ||
         /\b\d{4}\s*[-–]\s*(present|\d{4})\b/.test(content)); // Date ranges like "2020 - Present"

      return hasResumeTitle || hasResumeContent;
    });
  }

  /**
   * Resume-specific fallback message
   */
  getFallbackMessage() {
    return "I couldn't find any resume or CV documents in your collection to analyze candidate information.";
  }
}

export default ResumeAgent;
