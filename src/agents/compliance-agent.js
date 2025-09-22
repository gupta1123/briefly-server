import BaseAgent from './base-agent.js';

/**
 * Compliance Agent - Policy compliance checking and risk assessment
 * 
 * Specializes in checking documents against organizational policies, regulations, and compliance requirements.
 */
class ComplianceAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.type = 'compliance';
  }

  /**
   * Process a compliance request
   */
  async process(question, documents, conversation = []) {
    console.log(`⚖️ Compliance Agent: Processing compliance question "${question}"`);
    
    try {
      // Extract compliance parameters
      const complianceParams = await this.extractComplianceParams(question, documents, conversation);
      
      // Check document compliance
      const complianceResults = await this.checkCompliance(complianceParams, documents);
      
      // Assess risks
      const riskAssessment = await this.assessRisks(complianceResults, complianceParams);
      
      // Generate recommendations
      const recommendations = await this.generateComplianceRecommendations(riskAssessment, complianceParams);
      
      // Format response
      const response = this.formatComplianceResponse(complianceResults, riskAssessment, recommendations, complianceParams);
      
      console.log(`✅ Compliance Agent: Completed compliance check for ${documents.length} documents`);
      
      return {
        answer: response.answer,
        confidence: 0.9,
        citations: response.citations,
        metadata: {
          documentsChecked: documents.length,
          complianceIssues: complianceResults.nonCompliantDocuments.length,
          riskLevel: riskAssessment.overallRiskLevel,
          recommendationsCount: recommendations.length
        }
      };
    } catch (error) {
      console.error('❌ Compliance Agent Error:', error);
      return {
        answer: 'I encountered an error while checking compliance. Please try rephrasing your compliance question.',
        confidence: 0.1,
        citations: []
      };
    }
  }

  /**
   * Extract compliance parameters
   */
  async extractComplianceParams(question, documents, conversation = []) {
    // Extract compliance standard/policy
    const standard = this.extractComplianceStandard(question);
    
    // Extract scope of compliance check
    const scope = this.extractComplianceScope(question, documents, conversation);
    
    // Extract compliance requirements
    const requirements = this.extractComplianceRequirements(question);
    
    // Extract risk tolerance
    const riskTolerance = this.extractRiskTolerance(question);
    
    return {
      question,
      standard,
      scope,
      requirements,
      riskTolerance,
      documents: scope.documentIds.length > 0 
        ? documents.filter(doc => scope.documentIds.includes(doc.id))
        : documents
    };
  }

  /**
   * Extract compliance standard
   */
  extractComplianceStandard(question) {
    const questionLower = question.toLowerCase();
    
    // Common compliance standards
    const standards = [
      { pattern: /(?:gdpr|general data protection regulation)/i, standard: 'GDPR', type: 'privacy' },
      { pattern: /(?:hipaa|health insurance portability and accountability act)/i, standard: 'HIPAA', type: 'healthcare' },
      { pattern: /(?:sox|sarbanes-oxley)/i, standard: 'SOX', type: 'financial' },
      { pattern: /(?:pci[-\s]?dss|payment card industry)/i, standard: 'PCI-DSS', type: 'payment' },
      { pattern: /(?:iso[-\s]?27001|information security management)/i, standard: 'ISO 27001', type: 'security' },
      { pattern: /(?:soc[-\s]?2|service organization control)/i, standard: 'SOC 2', type: 'security' },
      { pattern: /(?:ferpa|family educational rights and privacy act)/i, standard: 'FERPA', type: 'education' },
      { pattern: /(?:glba|gramm-leach-bliley act)/i, standard: 'GLBA', type: 'financial' },
      { pattern: /(?:ccpa|california consumer privacy act)/i, standard: 'CCPA', type: 'privacy' },
      { pattern: /(?:coppa|children['’]s online privacy protection act)/i, standard: 'COPPA', type: 'privacy' }
    ];
    
    // Check for specific standard mentions
    for (const { pattern, standard, type } of standards) {
      if (pattern.test(questionLower)) {
        return {
          name: standard,
          type: type,
          description: this.getStandardDescription(standard)
        };
      }
    }
    
    // Default to organizational compliance
    return {
      name: 'Organizational Policy',
      type: 'internal',
      description: 'Internal company policies and procedures'
    };
  }

  /**
   * Get standard description
   */
  getStandardDescription(standard) {
    const descriptions = {
      'GDPR': 'General Data Protection Regulation - EU data privacy law',
      'HIPAA': 'Health Insurance Portability and Accountability Act - US healthcare data protection',
      'SOX': 'Sarbanes-Oxley Act - US financial reporting and corporate governance',
      'PCI-DSS': 'Payment Card Industry Data Security Standard - Payment card data protection',
      'ISO 27001': 'Information Security Management - International information security standard',
      'SOC 2': 'Service Organization Control 2 - Trust services criteria for security and privacy',
      'FERPA': 'Family Educational Rights and Privacy Act - US education record privacy',
      'GLBA': 'Gramm-Leach-Bliley Act - US financial privacy law',
      'CCPA': 'California Consumer Privacy Act - California consumer data rights',
      'COPPA': 'Children\'s Online Privacy Protection Act - US children\'s online privacy protection'
    };
    
    return descriptions[standard] || 'Compliance standard';
  }

  /**
   * Extract compliance scope
   */
  extractComplianceScope(question, documents, conversation = []) {
    const scope = {
      documentIds: [],
      categories: [],
      dateRange: {},
      senders: [],
      receivers: [],
      tags: [],
      limit: 100 // Default limit
    };
    
    // Extract document references
    const docRefs = this.extractDocumentReferences(question, documents);
    scope.documentIds.push(...docRefs);
    
    // Extract categories
    const categoryPattern = /(?:in|within|from)\s+(?:category|categories)\s+["']?([^"']+?)["']?/gi;
    let categoryMatch;
    while ((categoryMatch = categoryPattern.exec(question)) !== null) {
      scope.categories.push(categoryMatch[1].trim());
    }
    
    // Extract senders/receivers
    const senderPattern = /(?:from|by|sender)\s+["']?([^"']+?)["']?/gi;
    let senderMatch;
    while ((senderMatch = senderPattern.exec(question)) !== null) {
      scope.senders.push(senderMatch[1].trim());
    }
    
    const receiverPattern = /(?:to|recipient|receiver)\s+["']?([^"']+?)["']?/gi;
    let receiverMatch;
    while ((receiverPattern.exec(question)) !== null) {
      scope.receivers.push(receiverMatch[1].trim());
    }
    
    // Extract date range
    const dateRange = this.extractDateRange(question);
    if (dateRange.start || dateRange.end) {
      scope.dateRange = dateRange;
    }
    
    // Extract tags
    const tagPattern = /(?:tag|tags)\s+["']?([^"']+?)["']?/gi;
    let tagMatch;
    while ((tagMatch = tagPattern.exec(question)) !== null) {
      scope.tags.push(tagMatch[1].trim());
    }
    
    // Extract limit
    const limitMatch = question.match(/(?:first|last|top|limit)\s+(\d+)/i);
    if (limitMatch) {
      scope.limit = Math.min(500, parseInt(limitMatch[1])); // Cap at 500
    }
    
    return scope;
  }

  /**
   * Extract compliance requirements
   */
  extractComplianceRequirements(question) {
    const requirements = {
      privacy: [],
      security: [],
      data_handling: [],
      retention: [],
      access_control: [],
      audit: []
    };
    
    // Extract privacy requirements
    const privacyKeywords = ['personal data', 'pii', 'sensitive', 'confidential', 'privacy', 'consent'];
    privacyKeywords.forEach(keyword => {
      if (question.toLowerCase().includes(keyword)) {
        requirements.privacy.push(keyword);
      }
    });
    
    // Extract security requirements
    const securityKeywords = ['encryption', 'password', 'authentication', 'access', 'authorization', 'security', 'breach', 'incident'];
    securityKeywords.forEach(keyword => {
      if (question.toLowerCase().includes(keyword)) {
        requirements.security.push(keyword);
      }
    });
    
    // Extract data handling requirements
    const dataHandlingKeywords = ['collection', 'processing', 'storage', 'transfer', 'sharing', 'deletion', 'disposal'];
    dataHandlingKeywords.forEach(keyword => {
      if (question.toLowerCase().includes(keyword)) {
        requirements.data_handling.push(keyword);
      }
    });
    
    // Extract retention requirements
    const retentionKeywords = ['retention', 'archive', 'delete', 'destroy', 'expire', 'period'];
    retentionKeywords.forEach(keyword => {
      if (question.toLowerCase().includes(keyword)) {
        requirements.retention.push(keyword);
      }
    });
    
    // Extract access control requirements
    const accessControlKeywords = ['role', 'permission', 'access', 'authorize', 'authenticate', 'approval'];
    accessControlKeywords.forEach(keyword => {
      if (question.toLowerCase().includes(keyword)) {
        requirements.access_control.push(keyword);
      }
    });
    
    // Extract audit requirements
    const auditKeywords = ['audit', 'log', 'record', 'trail', 'monitor', 'review'];
    auditKeywords.forEach(keyword => {
      if (question.toLowerCase().includes(keyword)) {
        requirements.audit.push(keyword);
      }
    });
    
    return requirements;
  }

  /**
   * Extract risk tolerance
   */
  extractRiskTolerance(question) {
    const questionLower = question.toLowerCase();
    
    if (questionLower.includes('strict') || questionLower.includes('high') || questionLower.includes('zero tolerance')) {
      return 'strict';
    } else if (questionLower.includes('moderate') || questionLower.includes('balanced')) {
      return 'moderate';
    } else if (questionLower.includes('relaxed') || questionLower.includes('lenient')) {
      return 'relaxed';
    } else {
      return 'moderate'; // Default
    }
  }

  /**
   * Check document compliance
   */
  async checkCompliance(params, documents) {
    console.log('⚖️ Compliance Agent: Checking document compliance');
    
    // Filter documents based on scope
    let compliantDocuments = documents;
    
    if (params.scope.categories.length > 0) {
      compliantDocuments = compliantDocuments.filter(doc => 
        params.scope.categories.some(cat => 
          (doc.category || '').toLowerCase().includes(cat.toLowerCase())
        )
      );
    }
    
    if (params.scope.senders.length > 0) {
      compliantDocuments = compliantDocuments.filter(doc => 
        params.scope.senders.some(sender => 
          (doc.sender || '').toLowerCase().includes(sender.toLowerCase())
        )
      );
    }
    
    if (params.scope.receivers.length > 0) {
      compliantDocuments = compliantDocuments.filter(doc => 
        params.scope.receivers.some(receiver => 
          (doc.receiver || '').toLowerCase().includes(receiver.toLowerCase())
        )
      );
    }
    
    if (params.scope.tags.length > 0) {
      compliantDocuments = compliantDocuments.filter(doc => 
        params.scope.tags.some(tag => 
          (doc.tags || []).some(docTag => 
            docTag.toLowerCase().includes(tag.toLowerCase())
          )
        )
      );
    }
    
    // Apply date range filter
    if (params.scope.dateRange.start || params.scope.dateRange.end) {
      compliantDocuments = compliantDocuments.filter(doc => {
        const docDate = new Date(doc.document_date || doc.uploaded_at);
        return (
          (!params.scope.dateRange.start || docDate >= params.scope.dateRange.start) &&
          (!params.scope.dateRange.end || docDate <= params.scope.dateRange.end)
        );
      });
    }
    
    // Limit documents
    compliantDocuments = compliantDocuments.slice(0, params.scope.limit);
    
    // Evaluate each document for compliance
    const complianceResults = await this.evaluateDocumentCompliance(compliantDocuments, params);
    
    // Identify non-compliant documents
    const nonCompliantDocuments = complianceResults.filter(result => 
      result.complianceStatus === 'non_compliant' || result.complianceStatus === 'partial_compliance'
    );
    
    return {
      allDocuments: compliantDocuments,
      compliantDocuments: complianceResults.filter(result => result.complianceStatus === 'compliant'),
      nonCompliantDocuments,
      partialComplianceDocuments: complianceResults.filter(result => result.complianceStatus === 'partial_compliance'),
      complianceResults
    };
  }

  /**
   * Evaluate document compliance
   */
  async evaluateDocumentCompliance(documents, params) {
    const results = [];
    
    for (const doc of documents) {
      const evaluation = {
        documentId: doc.id,
        documentTitle: doc.title || doc.filename || 'Untitled',
        complianceChecks: [],
        complianceStatus: 'unknown',
        violations: [],
        recommendations: []
      };
      
      // Perform standard-specific compliance checks
      switch (params.standard.name) {
        case 'GDPR':
          await this.checkGDPRCompliance(doc, evaluation, params);
          break;
        case 'HIPAA':
          await this.checkHIPAACompliance(doc, evaluation, params);
          break;
        case 'SOX':
          await this.checkSOXCompliance(doc, evaluation, params);
          break;
        default:
          await this.checkGeneralCompliance(doc, evaluation, params);
      }
      
      // Determine overall compliance status
      const violationCount = evaluation.violations.length;
      const checkCount = evaluation.complianceChecks.length;
      
      if (violationCount === 0 && checkCount > 0) {
        evaluation.complianceStatus = 'compliant';
      } else if (violationCount > 0 && violationCount < checkCount) {
        evaluation.complianceStatus = 'partial_compliance';
      } else if (violationCount > 0) {
        evaluation.complianceStatus = 'non_compliant';
      }
      
      results.push(evaluation);
    }
    
    return results;
  }

  /**
   * Check GDPR compliance
   */
  async checkGDPRCompliance(document, evaluation, params) {
    // Check for personal data indicators
    const personalDataIndicators = [
      'personal data', 'pii', 'name', 'address', 'email', 'phone', 'id number', 
      'location data', 'ip address', 'cookie', 'social security'
    ];
    
    const content = (document.subject || '') + ' ' + (document.description || '');
    const hasPersonalData = personalDataIndicators.some(indicator => 
      content.toLowerCase().includes(indicator.toLowerCase())
    );
    
    evaluation.complianceChecks.push({
      check: 'personal_data_detection',
      description: 'Detect presence of personal data',
      result: hasPersonalData,
      requirement: 'Article 4 - Definition of personal data'
    });
    
    if (hasPersonalData) {
      // Check for consent indicators
      const consentIndicators = ['consent', 'permission', 'agree', 'opt-in', 'opt-out'];
      const hasConsent = consentIndicators.some(indicator => 
        content.toLowerCase().includes(indicator.toLowerCase())
      );
      
      evaluation.complianceChecks.push({
        check: 'consent_obtained',
        description: 'Verify consent for processing personal data',
        result: hasConsent,
        requirement: 'Article 6 - Lawfulness of processing'
      });
      
      if (!hasConsent) {
        evaluation.violations.push({
          type: 'missing_consent',
          description: 'Personal data present without apparent consent',
          severity: 'high',
          recommendation: 'Obtain explicit consent for processing this personal data'
        });
      }
      
      // Check for data retention policy
      const retentionIndicators = ['retain', 'keep', 'store', 'delete', 'expire'];
      const hasRetention = retentionIndicators.some(indicator => 
        content.toLowerCase().includes(indicator.toLowerCase())
      );
      
      evaluation.complianceChecks.push({
        check: 'retention_policy',
        description: 'Verify data retention policy compliance',
        result: hasRetention,
        requirement: 'Article 17 - Right to erasure'
      });
      
      if (!hasRetention) {
        evaluation.violations.push({
          type: 'missing_retention_policy',
          description: 'Personal data retention period not specified',
          severity: 'medium',
          recommendation: 'Specify retention period for personal data'
        });
      }
    }
  }

  /**
   * Check HIPAA compliance
   */
  async checkHIPAACompliance(document, evaluation, params) {
    // Check for protected health information (PHI) indicators
    const phiIndicators = [
      'medical record', 'health information', 'patient', 'hospital', 'doctor', 
      'clinic', 'treatment', 'diagnosis', 'prescription', 'insurance', 'medicare', 
      'medicaid', 'health plan'
    ];
    
    const content = (document.subject || '') + ' ' + (document.description || '');
    const hasPHI = phiIndicators.some(indicator => 
      content.toLowerCase().includes(indicator.toLowerCase())
    );
    
    evaluation.complianceChecks.push({
      check: 'phi_detection',
      description: 'Detect presence of protected health information',
      result: hasPHI,
      requirement: '45 CFR § 160.103 - Definitions'
    });
    
    if (hasPHI) {
      // Check for authorization
      const authorizationIndicators = ['authorized', 'authorization', 'permission', 'consent'];
      const hasAuthorization = authorizationIndicators.some(indicator => 
        content.toLowerCase().includes(indicator.toLowerCase())
      );
      
      evaluation.complianceChecks.push({
        check: 'authorization_obtained',
        description: 'Verify patient authorization for PHI use',
        result: hasAuthorization,
        requirement: '45 CFR § 164.508 - Uses and disclosures for which an authorization is required'
      });
      
      if (!hasAuthorization) {
        evaluation.violations.push({
          type: 'missing_authorization',
          description: 'Protected health information present without apparent authorization',
          severity: 'high',
          recommendation: 'Obtain patient authorization for PHI disclosure'
        });
      }
      
      // Check for minimum necessary standard
      const broadDistributionIndicators = ['everyone', 'all employees', 'wide distribution', 'broadcast'];
      const hasBroadDistribution = broadDistributionIndicators.some(indicator => 
        content.toLowerCase().includes(indicator.toLowerCase())
      );
      
      evaluation.complianceChecks.push({
        check: 'minimum_necessary',
        description: 'Verify minimum necessary standard compliance',
        result: !hasBroadDistribution,
        requirement: '45 CFR § 164.502 - Minimum necessary standard'
      });
      
      if (hasBroadDistribution) {
        evaluation.violations.push({
          type: 'violation_minimum_necessary',
          description: 'PHI distributed beyond minimum necessary recipients',
          severity: 'high',
          recommendation: 'Restrict PHI distribution to minimum necessary personnel only'
        });
      }
    }
  }

  /**
   * Check SOX compliance
   */
  async checkSOXCompliance(document, evaluation, params) {
    // Check for financial reporting indicators
    const financialIndicators = [
      'financial statement', 'balance sheet', 'income statement', 'cash flow', 
      'audit report', 'revenue', 'expense', 'profit', 'loss', 'asset', 'liability',
      'equity', 'dividend', 'stock', 'shareholder', 'investor'
    ];
    
    const content = (document.subject || '') + ' ' + (document.description || '');
    const hasFinancialInfo = financialIndicators.some(indicator => 
      content.toLowerCase().includes(indicator.toLowerCase())
    );
    
    evaluation.complianceChecks.push({
      check: 'financial_information',
      description: 'Detect presence of financial reporting information',
      result: hasFinancialInfo,
      requirement: 'Section 302 - Corporate Responsibility for Financial Reports'
    });
    
    if (hasFinancialInfo) {
      // Check for management certification
      const certificationIndicators = ['certify', 'certification', 'management assessment', 'internal control'];
      const hasCertification = certificationIndicators.some(indicator => 
        content.toLowerCase().includes(indicator.toLowerCase())
      );
      
      evaluation.complianceChecks.push({
        check: 'management_certification',
        description: 'Verify management certification of financial reports',
        result: hasCertification,
        requirement: 'Section 302 - Corporate Responsibility for Financial Reports'
      });
      
      if (!hasCertification) {
        evaluation.violations.push({
          type: 'missing_certification',
          description: 'Financial information present without management certification',
          severity: 'high',
          recommendation: 'Include management certification for financial documents'
        });
      }
      
      // Check for internal controls
      const controlIndicators = ['internal control', 'control environment', 'risk assessment', 'control activities'];
      const hasControls = controlIndicators.some(indicator => 
        content.toLowerCase().includes(indicator.toLowerCase())
      );
      
      evaluation.complianceChecks.push({
        check: 'internal_controls',
        description: 'Verify internal control documentation',
        result: hasControls,
        requirement: 'Section 404 - Management Assessment of Internal Controls'
      });
      
      if (!hasControls) {
        evaluation.violations.push({
          type: 'missing_internal_controls',
          description: 'Financial documents lack internal control documentation',
          severity: 'medium',
          recommendation: 'Document internal controls for financial processes'
        });
      }
    }
  }

  /**
   * Check general organizational compliance
   */
  async checkGeneralCompliance(document, evaluation, params) {
    // Check for document metadata completeness
    const metadataChecks = [
      { field: 'title', value: document.title, required: true },
      { field: 'category', value: document.category, required: true },
      { field: 'sender', value: document.sender, required: true },
      { field: 'document_date', value: document.document_date, required: true }
    ];
    
    metadataChecks.forEach(check => {
      const hasValue = Boolean(check.value);
      evaluation.complianceChecks.push({
        check: `metadata_${check.field}`,
        description: `Verify ${check.field.replace('_', ' ')} completeness`,
        result: hasValue || !check.required,
        requirement: 'Organizational document metadata policy'
      });
      
      if (check.required && !hasValue) {
        evaluation.violations.push({
          type: 'missing_metadata',
          description: `Required document metadata field '${check.field}' is missing`,
          severity: 'low',
          recommendation: `Complete the ${check.field.replace('_', ' ')} field for this document`
        });
      }
    });
    
    // Check for sensitive information without protection
    const sensitiveIndicators = ['confidential', 'secret', 'classified', 'proprietary', 'trade secret'];
    const content = (document.subject || '') + ' ' + (document.description || '');
    const hasSensitiveInfo = sensitiveIndicators.some(indicator => 
      content.toLowerCase().includes(indicator.toLowerCase())
    );
    
    if (hasSensitiveInfo) {
      // Check if document is in restricted folder
      const isInRestrictedLocation = Array.isArray(document.folder_path) && 
        document.folder_path.some(folder => 
          folder.toLowerCase().includes('restricted') || folder.toLowerCase().includes('confidential')
        );
      
      evaluation.complianceChecks.push({
        check: 'sensitive_information_protection',
        description: 'Verify protection of sensitive information',
        result: isInRestrictedLocation,
        requirement: 'Organizational information classification policy'
      });
      
      if (!isInRestrictedLocation) {
        evaluation.violations.push({
          type: 'unprotected_sensitive_info',
          description: 'Sensitive information not stored in protected location',
          severity: 'medium',
          recommendation: 'Move document to restricted/confidential folder'
        });
      }
    }
    
    // Check for document retention compliance
    if (document.document_date) {
      const docDate = new Date(document.document_date);
      const now = new Date();
      const ageInYears = (now - docDate) / (1000 * 60 * 60 * 24 * 365);
      
      // Assume 7-year retention for most business documents
      if (ageInYears > 7) {
        evaluation.complianceChecks.push({
          check: 'document_retention',
          description: 'Verify document retention period compliance',
          result: false,
          requirement: 'Organizational 7-year document retention policy'
        });
        
        evaluation.violations.push({
          type: 'expired_retention_period',
          description: `Document exceeds retention period (${Math.floor(ageInYears)} years old)`,
          severity: 'medium',
          recommendation: 'Review document for archival or destruction per retention schedule'
        });
      }
    }
  }

  /**
   * Assess risks
   */
  async assessRisks(complianceResults, params) {
    console.log('⚖️ Compliance Agent: Assessing compliance risks');
    
    const riskAssessment = {
      overallRiskLevel: 'low',
      riskScore: 0,
      individualRisks: [],
      aggregatedRisks: {
        high: 0,
        medium: 0,
        low: 0
      }
    };
    
    // Aggregate risks from all documents
    complianceResults.complianceResults.forEach(result => {
      result.violations.forEach(violation => {
        riskAssessment.individualRisks.push({
          documentId: result.documentId,
          documentTitle: result.documentTitle,
          violation: violation,
          riskLevel: violation.severity
        });
        
        // Count risk levels
        riskAssessment.aggregatedRisks[violation.severity]++;
      });
    });
    
    // Calculate overall risk score
    const highRiskScore = riskAssessment.aggregatedRisks.high * 10;
    const mediumRiskScore = riskAssessment.aggregatedRisks.medium * 5;
    const lowRiskScore = riskAssessment.aggregatedRisks.low * 2;
    
    riskAssessment.riskScore = highRiskScore + mediumRiskScore + lowRiskScore;
    
    // Determine overall risk level
    if (riskAssessment.riskScore >= 50) {
      riskAssessment.overallRiskLevel = 'high';
    } else if (riskAssessment.riskScore >= 20) {
      riskAssessment.overallRiskLevel = 'medium';
    } else {
      riskAssessment.overallRiskLevel = 'low';
    }
    
    // Adjust based on risk tolerance
    if (params.riskTolerance === 'strict' && riskAssessment.overallRiskLevel !== 'high') {
      riskAssessment.overallRiskLevel = 'medium';
    } else if (params.riskTolerance === 'relaxed' && riskAssessment.overallRiskLevel === 'high') {
      riskAssessment.overallRiskLevel = 'medium';
    }
    
    return riskAssessment;
  }

  /**
   * Generate compliance recommendations
   */
  async generateComplianceRecommendations(riskAssessment, params) {
    const recommendations = [];
    
    // General recommendations based on risk assessment
    if (riskAssessment.aggregatedRisks.high > 0) {
      recommendations.push({
        type: 'immediate_action',
        title: '🔴 Immediate Compliance Action Required',
        description: `Address ${riskAssessment.aggregatedRisks.high} high-risk compliance violations immediately to prevent regulatory penalties.`,
        priority: 'high',
        timeframe: 'immediate'
      });
    }
    
    if (riskAssessment.aggregatedRisks.medium > 0) {
      recommendations.push({
        type: 'short_term',
        title: '🟡 Short-term Compliance Improvements',
        description: `Address ${riskAssessment.aggregatedRisks.medium} medium-risk compliance issues within 30 days.`,
        priority: 'medium',
        timeframe: '30_days'
      });
    }
    
    if (riskAssessment.aggregatedRisks.low > 0) {
      recommendations.push({
        type: 'ongoing_improvement',
        title: '🟢 Ongoing Compliance Enhancement',
        description: `Monitor and gradually improve ${riskAssessment.aggregatedRisks.low} low-risk compliance areas as part of continuous improvement.`,
        priority: 'low',
        timeframe: 'ongoing'
      });
    }
    
    // Specific recommendations based on compliance standard
    switch (params.standard.name) {
      case 'GDPR':
        recommendations.push(...this.generateGDPRRecommendations(params));
        break;
      case 'HIPAA':
        recommendations.push(...this.generateHIPAARecommendations(params));
        break;
      case 'SOX':
        recommendations.push(...this.generateSOXRecommendations(params));
        break;
      default:
        recommendations.push(...this.generateGeneralRecommendations(params));
    }
    
    // Training recommendations
    recommendations.push({
      type: 'training',
      title: '📚 Staff Training Recommendation',
      description: 'Provide compliance training to staff on document handling procedures and regulatory requirements.',
      priority: 'medium',
      timeframe: '90_days'
    });
    
    return recommendations;
  }

  /**
   * Generate GDPR-specific recommendations
   */
  generateGDPRRecommendations(params) {
    return [
      {
        type: 'gdpr_specific',
        title: 'GDPR Data Mapping',
        description: 'Create comprehensive data mapping to identify all personal data processing activities.',
        priority: 'high',
        timeframe: '60_days'
      },
      {
        type: 'gdpr_specific',
        title: 'Privacy Impact Assessment',
        description: 'Conduct Privacy Impact Assessments (PIAs) for high-risk data processing activities.',
        priority: 'medium',
        timeframe: '90_days'
      }
    ];
  }

  /**
   * Generate HIPAA-specific recommendations
   */
  generateHIPAARecommendations(params) {
    return [
      {
        type: 'hipaa_specific',
        title: 'HIPAA Security Rule Assessment',
        description: 'Conduct comprehensive assessment of administrative, physical, and technical safeguards.',
        priority: 'high',
        timeframe: '45_days'
      },
      {
        type: 'hipaa_specific',
        title: 'Business Associate Agreements',
        description: 'Review and update Business Associate Agreements (BAAs) with all third-party vendors.',
        priority: 'medium',
        timeframe: '60_days'
      }
    ];
  }

  /**
   * Generate SOX-specific recommendations
   */
  generateSOXRecommendations(params) {
    return [
      {
        type: 'sox_specific',
        title: 'Internal Control Documentation',
        description: 'Enhance internal control documentation and testing procedures for financial reporting.',
        priority: 'high',
        timeframe: '90_days'
      },
      {
        type: 'sox_specific',
        title: 'Management Certification Process',
        description: 'Strengthen management certification process for financial documents and reports.',
        priority: 'high',
        timeframe: '60_days'
      }
    ];
  }

  /**
   * Generate general compliance recommendations
   */
  generateGeneralRecommendations(params) {
    return [
      {
        type: 'general',
        title: 'Document Classification Policy',
        description: 'Implement formal document classification policy with clear labeling procedures.',
        priority: 'medium',
        timeframe: '30_days'
      },
      {
        type: 'general',
        title: 'Regular Compliance Audits',
        description: 'Schedule quarterly compliance audits to proactively identify and address issues.',
        priority: 'medium',
        timeframe: 'ongoing'
      }
    ];
  }

  /**
   * Format compliance response
   */
  formatComplianceResponse(complianceResults, riskAssessment, recommendations, params) {
    let response = `## ⚖️ Compliance Report\n\n`;
    
    // Compliance Summary
    response += `### 📊 Compliance Summary\n\n`;
    response += `- **Standard Checked:** ${params.standard.name}\n`;
    response += `- **Documents Analyzed:** ${complianceResults.allDocuments.length}\n`;
    response += `- **Compliant Documents:** ${complianceResults.compliantDocuments.length}\n`;
    response += `- **Non-Compliant Documents:** ${complianceResults.nonCompliantDocuments.length}\n`;
    response += `- **Partial Compliance:** ${complianceResults.partialComplianceDocuments.length}\n`;
    response += `- **Overall Risk Level:** ${this.formatRiskLevel(riskAssessment.overallRiskLevel)}\n`;
    response += `- **Total Risk Score:** ${riskAssessment.riskScore}\n\n`;
    
    // Risk Assessment
    if (riskAssessment.individualRisks.length > 0) {
      response += `### ⚠️ Risk Assessment\n\n`;
      
      // Risk breakdown
      response += `**Risk Distribution:**\n`;
      response += `- 🔴 High Risk: ${riskAssessment.aggregatedRisks.high}\n`;
      response += `- 🟡 Medium Risk: ${riskAssessment.aggregatedRisks.medium}\n`;
      response += `- 🟢 Low Risk: ${riskAssessment.aggregatedRisks.low}\n\n`;
      
      // Top risks
      const topRisks = riskAssessment.individualRisks
        .slice(0, 5)
        .sort((a, b) => {
          const severityOrder = { high: 3, medium: 2, low: 1 };
          return severityOrder[b.violation.severity] - severityOrder[a.violation.severity];
        });
      
      if (topRisks.length > 0) {
        response += `**Top Compliance Risks:**\n\n`;
        topRisks.forEach((risk, index) => {
          const severityEmoji = risk.violation.severity === 'high' ? '🔴' : 
                                risk.violation.severity === 'medium' ? '🟡' : '🟢';
          response += `${index + 1}. ${severityEmoji} **${risk.documentTitle}**\n`;
          response += `   - Violation: ${risk.violation.description}\n`;
          response += `   - Recommendation: ${risk.violation.recommendation}\n\n`;
        });
      }
    }
    
    // Detailed Findings
    if (complianceResults.nonCompliantDocuments.length > 0) {
      response += `### 📋 Non-Compliant Documents\n\n`;
      
      complianceResults.nonCompliantDocuments
        .slice(0, 10) // Limit to top 10
        .forEach((doc, index) => {
          const statusEmoji = doc.complianceStatus === 'non_compliant' ? '❌' : '⚠️';
          response += `${index + 1}. ${statusEmoji} **${doc.documentTitle}**\n`;
          
          if (doc.violations.length > 0) {
            response += `   **Violations:**\n`;
            doc.violations.forEach(violation => {
              const severityEmoji = violation.severity === 'high' ? '🔴' : 
                                   violation.severity === 'medium' ? '🟡' : '🟢';
              response += `   - ${severityEmoji} ${violation.description}\n`;
            });
          }
          response += `\n`;
        });
      
      if (complianceResults.nonCompliantDocuments.length > 10) {
        response += `_... and ${complianceResults.nonCompliantDocuments.length - 10} more non-compliant documents_\n\n`;
      }
    }
    
    // Recommendations
    if (recommendations.length > 0) {
      response += `### 💡 Recommendations\n\n`;
      
      const priorityGroups = {
        high: recommendations.filter(r => r.priority === 'high'),
        medium: recommendations.filter(r => r.priority === 'medium'),
        low: recommendations.filter(r => r.priority === 'low')
      };
      
      if (priorityGroups.high.length > 0) {
        response += `**🔴 High Priority Actions:**\n\n`;
        priorityGroups.high.forEach((rec, index) => {
          response += `${index + 1}. **${rec.title}**\n`;
          response += `   ${rec.description}\n`;
          response += `   _Timeframe: ${rec.timeframe}_\n\n`;
        });
      }
      
      if (priorityGroups.medium.length > 0) {
        response += `**🟡 Medium Priority Actions:**\n\n`;
        priorityGroups.medium.forEach((rec, index) => {
          response += `${index + 1}. **${rec.title}**\n`;
          response += `   ${rec.description}\n`;
          response += `   _Timeframe: ${rec.timeframe}_\n\n`;
        });
      }
      
      if (priorityGroups.low.length > 0) {
        response += `**🟢 Low Priority Actions:**\n\n`;
        priorityGroups.low.forEach((rec, index) => {
          response += `${index + 1}. **${rec.title}**\n`;
          response += `   ${rec.description}\n`;
          response += `   _Timeframe: ${rec.timeframe}_\n\n`;
        });
      }
    }
    
    // Compliance Standards
    response += `### 📚 Compliance Standards\n\n`;
    response += `**Applied Standard:** ${params.standard.name}\n`;
    response += `**Description:** ${params.standard.description}\n\n`;
    
    // Next Steps
    response += `### 🔄 Next Steps\n\n`;
    response += `1. Address high-priority violations immediately\n`;
    response += `2. Implement recommended compliance measures\n`;
    response += `3. Schedule follow-up compliance review in 30-60 days\n`;
    response += `4. Provide staff training on compliance requirements\n`;
    response += `5. Update compliance policies and procedures as needed\n\n`;
    
    // Generate citations for non-compliant documents
    const citations = complianceResults.nonCompliantDocuments.map(doc => ({
      docId: doc.documentId,
      title: doc.documentTitle
    }));
    
    return {
      answer: response,
      citations: citations
    };
  }

  /**
   * Format risk level with emoji
   */
  formatRiskLevel(level) {
    switch (level) {
      case 'high': return '🔴 High';
      case 'medium': return '🟡 Medium';
      case 'low': return '🟢 Low';
      default: return level;
    }
  }
}

export default ComplianceAgent;