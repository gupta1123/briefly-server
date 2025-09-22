/**
 * Retry Utility - Enhanced retry mechanisms with exponential backoff and circuit breaker pattern
 */

// Circuit breaker states
const CIRCUIT_STATES = {
  CLOSED: 'CLOSED',     // Normal operation
  OPEN: 'OPEN',         // Fail fast mode
  HALF_OPEN: 'HALF_OPEN' // Test mode
};

// Circuit breaker configuration
const CIRCUIT_CONFIG = {
  failureThreshold: 5,      // Number of failures before opening circuit
  timeout: 60000,           // Time to wait before half-open (1 minute)
  successThreshold: 3       // Number of successes before closing circuit
};

// Global circuit breaker state
const circuitBreaker = {
  state: CIRCUIT_STATES.CLOSED,
  failureCount: 0,
  successCount: 0,
  nextAttempt: Date.now()
};

/**
 * Check if circuit breaker is open
 * @returns {boolean} Whether circuit is open
 */
function isCircuitOpen() {
  if (circuitBreaker.state === CIRCUIT_STATES.OPEN) {
    // Check if we should move to half-open state
    if (Date.now() >= circuitBreaker.nextAttempt) {
      circuitBreaker.state = CIRCUIT_STATES.HALF_OPEN;
      console.log('🔄 Circuit breaker moving to HALF_OPEN state');
    }
  }
  return circuitBreaker.state === CIRCUIT_STATES.OPEN;
}

/**
 * Record a failure in the circuit breaker
 */
function recordFailure() {
  circuitBreaker.failureCount++;
  console.log(`❌ Circuit breaker failure recorded (${circuitBreaker.failureCount}/${CIRCUIT_CONFIG.failureThreshold})`);
  
  if (circuitBreaker.failureCount >= CIRCUIT_CONFIG.failureThreshold) {
    circuitBreaker.state = CIRCUIT_STATES.OPEN;
    circuitBreaker.nextAttempt = Date.now() + CIRCUIT_CONFIG.timeout;
    console.log(`⚠️  Circuit breaker OPENED. Will retry at ${new Date(circuitBreaker.nextAttempt).toISOString()}`);
  }
}

/**
 * Record a success in the circuit breaker
 */
function recordSuccess() {
  // Reset failure count on success
  circuitBreaker.failureCount = 0;
  
  if (circuitBreaker.state === CIRCUIT_STATES.HALF_OPEN) {
    circuitBreaker.successCount++;
    console.log(`✅ Circuit breaker success recorded (${circuitBreaker.successCount}/${CIRCUIT_CONFIG.successThreshold})`);
    
    if (circuitBreaker.successCount >= CIRCUIT_CONFIG.successThreshold) {
      circuitBreaker.state = CIRCUIT_STATES.CLOSED;
      circuitBreaker.successCount = 0;
      console.log('✅ Circuit breaker CLOSED');
    }
  } else if (circuitBreaker.state === CIRCUIT_STATES.CLOSED) {
    circuitBreaker.successCount = 0; // Reset success count in closed state
  }
}

/**
 * Enhanced sleep function with jitter
 * @param {number} ms - Base delay in milliseconds
 * @returns {Promise} Promise that resolves after delay with jitter
 */
function sleepWithJitter(ms) {
  const jitter = Math.random() * 0.3 * ms; // ±15% jitter
  const delay = ms + (Math.random() > 0.5 ? jitter : -jitter);
  return new Promise(resolve => setTimeout(resolve, Math.max(1, delay)));
}

/**
 * Calculate exponential backoff delay with full jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} options - Configuration options
 * @returns {number} Delay in milliseconds
 */
function calculateExponentialBackoff(attempt, options = {}) {
  const {
    baseDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    jitter = true
  } = options;
  
  // Exponential backoff: baseDelay * (factor ^ attempt)
  let delay = baseDelay * Math.pow(factor, attempt);
  
  // Apply jitter if requested
  if (jitter) {
    delay = Math.random() * delay;
  }
  
  // Cap at maximum delay
  return Math.min(delay, maxDelay);
}

/**
 * Enhanced retry function with circuit breaker and exponential backoff
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Retry configuration
 * @returns {Promise} Promise that resolves with operation result
 */
async function retryWithBackoff(operation, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    jitter = true,
    shouldRetry = () => true, // Function to determine if error should be retried
    onRetry = () => {},       // Callback when retry occurs
    circuitBreakerEnabled = true
  } = options;
  
  // Check circuit breaker
  if (circuitBreakerEnabled && isCircuitOpen()) {
    throw new Error('Circuit breaker is OPEN. Service temporarily unavailable.');
  }
  
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation(attempt);
      
      // Record success in circuit breaker
      if (circuitBreakerEnabled) {
        recordSuccess();
      }
      
      return result;
    } catch (error) {
      lastError = error;
      
      // Record failure in circuit breaker
      if (circuitBreakerEnabled) {
        recordFailure();
      }
      
      // If this is the last attempt, rethrow
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Check if we should retry this error
      if (!shouldRetry(error)) {
        throw error;
      }
      
      // Calculate delay
      const delay = calculateExponentialBackoff(attempt, { baseDelay, maxDelay, factor, jitter });
      
      // Call retry callback
      onRetry(attempt, delay, error);
      
      // Wait before retrying
      await sleepWithJitter(delay);
    }
  }
  
  // This should never be reached, but just in case
  throw lastError;
}

/**
 * Determine if an error should be retried
 * @param {Error} error - Error to check
 * @returns {boolean} Whether error should be retried
 */
function shouldRetryError(error) {
  // Don't retry certain types of errors
  if (error.code === 'RATE_LIMIT_EXCEEDED') {
    return true; // Rate limits should be retried
  }
  
  if (error.status === 429) {
    return true; // HTTP 429 Too Many Requests
  }
  
  if (error.status >= 500 && error.status < 600) {
    return true; // Server errors
  }
  
  if (error.message && (
    error.message.includes('timeout') ||
    error.message.includes('network') ||
    error.message.includes('connection')
  )) {
    return true; // Network-related errors
  }
  
  // Don't retry client errors (4xx except 429)
  if (error.status >= 400 && error.status < 500 && error.status !== 429) {
    return false;
  }
  
  // For other errors, retry by default
  return true;
}

/**
 * Create a retryable wrapper for an async function
 * @param {Function} fn - Function to wrap
 * @param {Object} options - Retry options
 * @returns {Function} Wrapped function
 */
function createRetryableFunction(fn, options = {}) {
  return async function(...args) {
    return await retryWithBackoff(
      async (attempt) => {
        return await fn(...args);
      },
      {
        shouldRetry: shouldRetryError,
        onRetry: (attempt, delay, error) => {
          console.log(`🔄 Retrying function (attempt ${attempt + 1}) in ${delay}ms: ${error.message}`);
        },
        ...options
      }
    );
  };
}

export {
  retryWithBackoff,
  createRetryableFunction,
  calculateExponentialBackoff,
  shouldRetryError,
  CIRCUIT_STATES,
  isCircuitOpen
};

export default {
  retryWithBackoff,
  createRetryableFunction,
  calculateExponentialBackoff,
  shouldRetryError,
  CIRCUIT_STATES,
  isCircuitOpen
};