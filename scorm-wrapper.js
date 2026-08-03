/**
 * SCORM 1.2 API Wrapper
 * Handles communication with LMS
 */

(function() {
  'use strict';

  let api = null;
  let initialized = false;
  let standaloneMode = false;  // Track if running without LMS

  // Find the SCORM API
  function findAPI(win) {
    let attempts = 0;
    const maxAttempts = 500;

    while (!win.API && win.parent && win.parent !== win && attempts < maxAttempts) {
      win = win.parent;
      attempts++;
    }

    return win.API || null;
  }

  function getAPI() {
    if (api) return api;

    // Try to find API in parent windows
    api = findAPI(window);

    // Try opener if not found
    if (!api && window.opener) {
      api = findAPI(window.opener);
    }

    return api;
  }

  // SCORM wrapper object
  window.SCORM = {
    /**
     * Initialize SCORM communication
     * @returns {string} 'true' if successful, 'false' if failed
     */
    LMSInitialize: function(param) {
      const lmsApi = getAPI();
      if (!lmsApi) {
        console.log('SCORM API not found - running in standalone mode');
        standaloneMode = true;
        initialized = true;  // Mark as "initialized" for standalone mode
        return 'true';
      }

      standaloneMode = false;
      const result = lmsApi.LMSInitialize(param);
      initialized = result === 'true';

      if (initialized) {
        // Set initial status if not already set
        const status = this.LMSGetValue('cmi.core.lesson_status');
        if (status === 'not attempted' || status === '') {
          this.LMSSetValue('cmi.core.lesson_status', 'incomplete');
        }
      }

      return result;
    },

    /**
     * Check if running in standalone mode (no LMS)
     * @returns {boolean} true if no LMS API was found
     */
    isStandaloneMode: function() {
      return standaloneMode;
    },

    /**
     * Check if SCORM connection is active
     * @returns {boolean} true if initialized (either LMS or standalone)
     */
    isInitialized: function() {
      return initialized;
    },

    /**
     * Finish SCORM session
     * @returns {string} 'true' if successful
     */
    LMSFinish: function(param) {
      if (standaloneMode) {
        initialized = false;
        return 'true';
      }

      const lmsApi = getAPI();
      if (!lmsApi || !initialized) return 'true';

      const result = lmsApi.LMSFinish(param);
      initialized = false;
      return result;
    },

    /**
     * Get a value from LMS
     * @returns {string} Value or empty string if not available
     */
    LMSGetValue: function(element) {
      if (standaloneMode) return '';

      const lmsApi = getAPI();
      if (!lmsApi || !initialized) return '';
      return lmsApi.LMSGetValue(element);
    },

    /**
     * Set a value in LMS
     * In standalone mode, returns 'true' but value is not persisted
     * @returns {string} 'true' if successful, 'false' if failed
     */
    LMSSetValue: function(element, value) {
      if (standaloneMode) return 'true';  // Silently succeed in standalone

      const lmsApi = getAPI();
      if (!lmsApi || !initialized) return 'true';
      return lmsApi.LMSSetValue(element, value);
    },

    /**
     * Commit data to LMS
     * @returns {string} 'true' if successful
     */
    LMSCommit: function(param) {
      if (standaloneMode) return 'true';

      const lmsApi = getAPI();
      if (!lmsApi || !initialized) return 'true';
      return lmsApi.LMSCommit(param);
    },

    /**
     * Get last error code
     * @returns {string} Error code or '0' if no error
     */
    LMSGetLastError: function() {
      if (standaloneMode) return '0';  // No errors in standalone

      const lmsApi = getAPI();
      if (!lmsApi) return '0';
      return lmsApi.LMSGetLastError();
    },

    /**
     * Get error description
     * @returns {string} Human-readable error message
     */
    LMSGetErrorString: function(errorCode) {
      if (standaloneMode) return 'Standalone mode - no LMS';

      const lmsApi = getAPI();
      if (!lmsApi) return '';
      return lmsApi.LMSGetErrorString(errorCode);
    },

    /**
     * Get diagnostic info for an error
     * @returns {string} Detailed diagnostic information
     */
    LMSGetDiagnostic: function(errorCode) {
      if (standaloneMode) return 'Running without LMS - progress not saved';

      const lmsApi = getAPI();
      if (!lmsApi) return '';
      return lmsApi.LMSGetDiagnostic(errorCode);
    }
  };

  // Handle page unload
  window.addEventListener('beforeunload', function() {
    if (initialized) {
      window.SCORM.LMSFinish('');
    }
  });
})();
