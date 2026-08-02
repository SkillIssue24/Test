/**
 * Slate Course Player
 * Modern e-learning player with responsive navigation and accessibility
 */

// Safe localStorage wrapper for sandboxed iframes
// Falls back to in-memory storage when localStorage is blocked
const safeStorage = (() => {
  const memoryStore = {}
  try {
    // Test if localStorage is accessible
    localStorage.setItem('__test__', '1')
    localStorage.removeItem('__test__')
    return {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key)
    }
  } catch {
    // localStorage blocked (sandboxed iframe), use memory fallback
    return {
      getItem: (key) => memoryStore[key] ?? null,
      setItem: (key, value) => { memoryStore[key] = value },
      removeItem: (key) => { delete memoryStore[key] }
    }
  }
})()

// HTML sanitization helpers for XSS prevention
const escapeHtml = (str) => {
  if (str == null) return ''
  const div = document.createElement('div')
  div.textContent = String(str)
  return div.innerHTML
}

const sanitizeHtml = (html) => {
  if (html == null) return ''
  // Use DOMPurify when available (recommended)
  if (window.DOMPurify) {
    return DOMPurify.sanitize(html, { ADD_ATTR: ['data-*'] })
  }
  // Fallback: basic sanitization for offline SCORM without DOMPurify
  // Removes dangerous tags and event handlers but preserves safe HTML
  const div = document.createElement('div')
  div.innerHTML = html
  // Remove dangerous tags
  div.querySelectorAll('script,iframe,object,embed,form,base,style,link,svg,math').forEach(el => el.remove())
  // Remove event handler attributes
  div.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith('on') || attr.value.toLowerCase().includes('javascript:')) {
        el.removeAttribute(attr.name)
      }
    })
  })
  return div.innerHTML
}

// Sanitize URL to prevent javascript: protocol
const sanitizeUrl = (url) => {
  if (url == null) return ''
  const trimmed = String(url).trim().toLowerCase()
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:text/html')) {
    return '#blocked'
  }
  return url
}

// Sanitize CSS class name(s) - only allow safe characters, reject reserved prefixes
const RESERVED_CLASS_PREFIXES = ['slate-', 'block-', 'review-', 'scorm-']
const sanitizeClassName = (className) => {
  if (!className || typeof className !== 'string') return ''
  return className
    .slice(0, 200)
    .split(/\s+/)
    .map(cls => cls.trim())
    .filter(cls => /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(cls))
    .filter(cls => !RESERVED_CLASS_PREFIXES.some(p => cls.toLowerCase().startsWith(p)))
    .join(' ')
}

// Detect the hosting provider for a document URL and return its display name,
// or '' if the URL is empty / not from a recognised provider. Brand names are
// proper nouns and intentionally not localised. Mirrors detectDocumentProvider
// in builder/src/lib/documentProviders.ts — keep the two in sync when adding
// or renaming providers.
const detectDocumentProviderName = (url) => {
  if (!url) return ''
  const u = String(url).toLowerCase()
  if (u.includes('drive.google.com') || u.includes('docs.google.com')) return 'Google Drive'
  if (u.includes('dropbox.com') || u.includes('dropboxusercontent.com')) return 'Dropbox'
  if (u.includes('sharepoint.com')) return 'SharePoint'
  if (u.includes('onedrive.live.com') || u.includes('1drv.ms')) return 'OneDrive'
  // Box: hostname boundaries only — avoid collisions with `toolbox.com`, `sandbox.*`, etc.
  if (u.includes('.box.com') || u.includes('//box.com/') || u.includes('boxcloud.com')) return 'Box'
  if (u.includes('icloud.com')) return 'iCloud'
  return ''
}

// Detect whether a flip-card side should render as an edge-to-edge image with no body chrome.
// A side is "image-only" when there is no title/subtitle and either:
//   (a) the side's `imageUrl` is set and there are no content items, OR
//   (b) the side's `imageUrl` is empty and items contains exactly one image item.
// Case (b) handles authors who add a single image via the content-items picker
// instead of the main image slot (common in Rise imports and manual authoring).
const resolveFlipCardSideImageOnly = (side) => {
  if (!side) return { imageOnly: false }
  const hasText = !!(side.title || side.subtitle)
  if (hasText) return { imageOnly: false }

  const items = Array.isArray(side.items) ? side.items : []
  const hasMainImage = !!side.imageUrl

  if (hasMainImage && items.length === 0) {
    return { imageOnly: true, imageUrl: side.imageUrl, imageAlt: side.imageAlt || '' }
  }

  if (!hasMainImage && items.length === 1 && items[0].type === 'image' && items[0].content) {
    return { imageOnly: true, imageUrl: items[0].content, imageAlt: items[0].alt || '' }
  }

  return { imageOnly: false }
}

// Clamp a coordinate to a valid 0-100 percentage, defaulting bad values to 50
// (center). Shared by image hotspots and card focal points.
const clampCoord = (v) => {
  const n = parseFloat(v)
  return (isNaN(n) || !isFinite(n)) ? 50 : Math.max(0, Math.min(100, n))
}

// Build the inline `object-position` style for a card cover image's focal point.
// Returns '' for absent or dead-center points so untouched cards emit
// byte-identical HTML to the pre-feature output (center is already the default).
const focalPointStyle = (focal) => {
  if (!focal) return ''
  const x = clampCoord(focal.x)
  const y = clampCoord(focal.y)
  if (x === 50 && y === 50) return ''
  return ` style="object-position:${x}% ${y}%"`
}

// Shape divider catalog. Mirror of builder/src/lib/shapeDividers.ts —
// keep both in sync when adding or editing shapes. Paths are designed
// for TOP-edge placement (painted area at top, curve facing down);
// bottom-edge use is flipped via `transform: scaleY(-1)`.
const SHAPE_DIVIDER_VIEWBOX = '0 0 1200 120'
const SHAPE_DIVIDER_PATHS = {
  'wave': 'M0,0 L1200,0 L1200,40 C900,120 300,-20 0,80 Z',
  'curve': 'M0,0 L1200,0 L1200,40 C800,120 400,120 0,40 Z',
  'tilt': 'M0,0 L1200,0 L1200,40 L0,120 Z',
  'triangle': 'M0,0 L1200,0 L600,120 Z',
  'mountains': 'M0,0 L1200,0 L1200,30 L1000,80 L850,40 L700,90 L520,30 L350,85 L180,35 L0,75 Z',
  'clouds': 'M0,0 L1200,0 L1200,60 C1100,60 1080,90 1000,90 C920,90 900,55 820,55 C740,55 720,95 640,95 C560,95 540,55 460,55 C380,55 360,90 280,90 C200,90 180,55 100,55 C40,55 0,75 0,75 Z',
  'zigzag': 'M0,0 L1200,0 L1200,40 L1080,90 L960,40 L840,90 L720,40 L600,90 L480,40 L360,90 L240,40 L120,90 L0,40 Z',
  'scallops': 'M0,0 L1200,0 L1200,40 C1162.5,90 1087.5,90 1050,40 C1012.5,90 937.5,90 900,40 C862.5,90 787.5,90 750,40 C712.5,90 637.5,90 600,40 C562.5,90 487.5,90 450,40 C412.5,90 337.5,90 300,40 C262.5,90 187.5,90 150,40 C112.5,90 37.5,90 0,40 Z',
  'steps': 'M0,0 L1200,0 L1200,30 L960,30 L960,55 L720,55 L720,80 L480,80 L480,105 L240,105 L240,120 L0,120 Z',
  // 'fade' is a special case rendered as a vertical alpha gradient, not a path.
}

// Build a "carve" SVG markup string for a band edge shape. Paints the band
// color in a full rectangle EXCEPT in the shape area, which is left
// transparent via fill-rule="evenodd". The result composites with the
// band's middle fill so the shape carves OUT of the band, exposing the
// surface behind. Theme-agnostic by construction — no surface color
// assumption, so it works on any theme background (white, dark, gradient,
// textured, etc.).
const buildShapeDividerCarveSvg = (shape, edge, flipX, fill) => {
  const transforms = []
  if (edge === 'bottom') transforms.push('scaleY(-1)')
  if (flipX) transforms.push('scaleX(-1)')
  const transformAttr = transforms.length
    ? ` style="transform:${transforms.join(' ')};transform-origin:center;"`
    : ''
  const safeFill = String(fill || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')

  // Fade renders as a vertical alpha gradient instead of a path carve;
  // band color is opaque at the band side and dissolves to transparent
  // at the surface side. Unique gradient ID prevents collisions when
  // multiple fade SVGs share a page.
  if (shape === 'fade') {
    const gradId = `slate-fade-${Math.random().toString(36).slice(2, 10)}`
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SHAPE_DIVIDER_VIEWBOX}"` +
      ` preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true"` +
      `${transformAttr}>` +
      `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${safeFill}" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="${safeFill}" stop-opacity="1"/>` +
      `</linearGradient></defs>` +
      `<rect width="1200" height="120" fill="url(#${gradId})"/>` +
      `</svg>`
    )
  }

  const path = SHAPE_DIVIDER_PATHS[shape]
  if (!path) return ''
  // Outer rect + shape with evenodd: paints around the shape, leaving the
  // shape region transparent so the surface behind shows through.
  const carvePath = `M0,0 H1200 V120 H0 Z ${path}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SHAPE_DIVIDER_VIEWBOX}"` +
    ` preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true"` +
    `${transformAttr}>` +
    `<path d="${carvePath}" fill="${safeFill}" fill-rule="evenodd"/>` +
    `</svg>`
  )
}

// Add error handlers to media elements (images, videos, audio)
const initMediaErrorHandlers = (container) => {
  // Handle image errors
  container.querySelectorAll('img').forEach(img => {
    if (img.dataset.errorHandled) return
    img.dataset.errorHandled = 'true'
    img.onerror = () => {
      img.style.display = 'none'
      const errorDiv = document.createElement('div')
      errorDiv.className = 'media-error'
      errorDiv.innerHTML = '<span class="media-error-icon">⚠</span><span>Image could not be loaded</span>'
      img.parentNode?.insertBefore(errorDiv, img)
    }
  })

  // Handle video errors
  container.querySelectorAll('video').forEach(video => {
    if (video.dataset.errorHandled) return
    video.dataset.errorHandled = 'true'
    video.onerror = () => {
      video.style.display = 'none'
      const errorDiv = document.createElement('div')
      errorDiv.className = 'media-error'
      errorDiv.innerHTML = '<span class="media-error-icon">⚠</span><span>Video could not be loaded</span>'
      video.parentNode?.insertBefore(errorDiv, video)
    }
  })

  // Handle audio errors
  container.querySelectorAll('audio').forEach(audio => {
    if (audio.dataset.errorHandled) return
    audio.dataset.errorHandled = 'true'
    audio.onerror = () => {
      audio.style.display = 'none'
      const errorDiv = document.createElement('div')
      errorDiv.className = 'media-error'
      errorDiv.innerHTML = '<span class="media-error-icon">⚠</span><span>Audio could not be loaded</span>'
      audio.parentNode?.insertBefore(errorDiv, audio)
    }
  })
}

// =============================================================================
// UI Localization Strings
// =============================================================================

const UI_STRINGS = {
  en: {
    a11y: {
      carouselPrev: 'Previous cards',
      carouselNext: 'Next cards',
      flipCarouselPrev: 'Previous card',
      flipCarouselNext: 'Next card',
      goToSlide: 'Go to slide {number}',
      flipCardHint: 'Flip card. Press Enter or click to flip.',
      flipHint: 'Click to flip',
      flipHintBack: 'Click to flip back',
      dataTable: 'Data table',
      courseProgress: 'Course progress',
      hotspot: 'Hotspot {number}',
    },
    nav: {
      previous: 'Previous',
      next: 'Next',
      progress: '{percent}% Complete',
      courseMenu: 'Course Menu',
      skipToContent: 'Skip to main content',
      toggleNav: 'Toggle navigation',
      openMenu: 'Open navigation menu',
      closeMenu: 'Close navigation menu',
      previousLesson: 'Previous Lesson',
      nextLesson: 'Next Lesson',
      upNext: 'Up Next',
      lessonProgress: 'Lesson {current} of {total}',
      courseComplete: 'You\'ve reached the end',
      finalLesson: 'Final Lesson',
      locked: 'Complete previous lessons to unlock',
      completeScroll: 'Reach the end of this lesson to continue.',
      completeQuestions: 'Answer this lesson\'s questions to continue.',
      completeInteractions: 'Open every activity on this page to continue.',
      completePacing: 'Available in {time}',
      exitCourse: 'Exit Course',
      exitFallbackTitle: 'Course Progress Saved',
      exitFallbackMessage: 'You may now close this tab.',
    },
    language: {
      select: 'Select language',
    },
    settings: {
      open: 'Settings',
      title: 'Settings',
      close: 'Close',
      display: 'Display',
      language: 'Language',
      highContrast: 'High contrast',
      highContrastDesc: 'Boost contrast for easier reading',
      highContrastOn: 'High contrast on',
      highContrastOff: 'High contrast off',
      textSize: 'Text size',
      textSizeIncrease: 'Increase text size',
      textSizeDecrease: 'Decrease text size',
      textSizeReset: 'Reset text size',
      textSizeAnnounce: 'Text size {percent}%',
    },
    assessment: {
      takeAssessment: 'Take Assessment',
      completed: 'Completed',
      locked: 'Locked',
      title: 'Assessment',
      description: 'Complete the following assessment to finish this course.',
      questions: 'Questions',
      passingScore: 'Passing Score',
      attempts: 'Attempts',
      unlimitedAttempts: 'Unlimited attempts',
      attemptCount: 'Attempt {current} of {max}',
      start: 'Start Assessment',
      questionNumber: 'Question {number}',
      answeredCount: '{answered} of {total} answered',
      submit: 'Submit Assessment',
      congratulations: 'Congratulations!',
      notPassed: 'Assessment Not Passed',
      successMessage: 'You have successfully completed the assessment.',
      failRetryMessage: 'You did not meet the passing score. You can try again.',
      noAttemptsMessage: 'You have used all available attempts.',
      scoreDisplay: '{correct} of {total} correct',
      tryAgain: 'Try Again',
      alreadyComplete: 'Assessment Complete',
      alreadyCompleteMessage: 'You have successfully completed this assessment.',
      lockedTitle: 'Assessment Locked',
      lockedMessage: 'You have used all available attempts and did not achieve a passing score.',
      bestScore: 'Best score achieved',
    },
    quiz: {
      selectAll: 'Select all that apply',
      answerOptions: 'Answer options',
      submit: 'Submit',
      answerRecorded: 'Answer recorded',
      typeAnswer: 'Type your answer...',
      answerInput: 'Your answer',
      correctAnswer: 'The correct answer is: {answer}',
      attemptCount: 'Attempt {current} of {max}',
    },
    media: {
      playNarration: 'Play narration',
      youtubeVideo: 'YouTube video',
      vimeoVideo: 'Vimeo video',
      googleDriveVideo: 'Google Drive video',
      synthesiaVideo: 'Synthesia video',
      loomVideo: 'Loom video',
      embeddedContent: 'Embedded content',
      showTranscript: 'Show Transcript',
      hideTranscript: 'Hide Transcript',
    },
    tabs: {
      contentTabs: 'Content tabs',
    },
    error: {
      loadingCourse: 'Error loading course content.',
      noLesson: 'No lesson found.',
      unsupportedBlock: 'Unsupported block type: {type}',
    },
    loading: {
      text: 'Loading...',
    },
    search: {
      placeholder: 'Search course...',
      clear: 'Clear search',
      noResults: 'No results for "{query}"',
      resultsCount: '{count} results',
    },
    hotspot: {
      close: 'Close',
    },
    conclusion: {
      continue: 'Continue',
      courseComplete: 'Course Complete',
    },
    cover: {
      begin: 'Begin Course',
      defaultMenuLabel: 'Welcome',
      estimatedDuration: '{minutes} min',
      lesson: '{count} lesson',
      lessons: '{count} lessons'
    },
  },
  'fr-CA': {
    a11y: {
      carouselPrev: 'Cartes précédentes',
      carouselNext: 'Cartes suivantes',
      flipCarouselPrev: 'Carte précédente',
      flipCarouselNext: 'Carte suivante',
      goToSlide: 'Aller à la diapositive {number}',
      flipCardHint: 'Retourner la carte. Appuyez sur Entrée ou cliquez pour retourner.',
      flipHint: 'Cliquez pour retourner',
      flipHintBack: 'Cliquez pour revenir',
      dataTable: 'Tableau de données',
      courseProgress: 'Progression du cours',
      hotspot: 'Point interactif {number}',
    },
    nav: {
      previous: 'Retour',
      next: 'Suivant',
      progress: '{percent}% Complété',
      courseMenu: 'Menu du cours',
      skipToContent: 'Passer au contenu principal',
      toggleNav: 'Basculer la navigation',
      openMenu: 'Ouvrir le menu de navigation',
      closeMenu: 'Fermer le menu de navigation',
      previousLesson: 'Leçon précédente',
      nextLesson: 'Leçon suivante',
      upNext: 'À suivre',
      lessonProgress: 'Leçon {current} de {total}',
      courseComplete: 'Vous avez atteint la fin',
      finalLesson: 'Dernière leçon',
      locked: 'Complétez les leçons précédentes pour débloquer',
      completeScroll: 'Atteignez la fin de cette leçon pour continuer.',
      completeQuestions: 'Répondez aux questions de cette leçon pour continuer.',
      completeInteractions: 'Ouvrez chaque activité de cette page pour continuer.',
      completePacing: 'Disponible dans {time}',
      exitCourse: 'Quitter le cours',
      exitFallbackTitle: 'Progression sauvegardée',
      exitFallbackMessage: 'Vous pouvez maintenant fermer cet onglet.',
    },
    language: {
      select: 'Sélectionner la langue',
    },
    settings: {
      open: 'Paramètres',
      title: 'Paramètres',
      close: 'Fermer',
      display: 'Affichage',
      language: 'Langue',
      highContrast: 'Contraste élevé',
      highContrastDesc: 'Augmente le contraste pour une lecture plus facile',
      highContrastOn: 'Contraste élevé activé',
      highContrastOff: 'Contraste élevé désactivé',
      textSize: 'Taille du texte',
      textSizeIncrease: 'Augmenter la taille du texte',
      textSizeDecrease: 'Réduire la taille du texte',
      textSizeReset: 'Réinitialiser la taille du texte',
      textSizeAnnounce: 'Taille du texte {percent} %',
    },
    assessment: {
      takeAssessment: 'Passer l\'évaluation',
      completed: 'Terminé',
      locked: 'Verrouillé',
      title: 'Évaluation',
      description: 'Complétez l\'évaluation suivante pour terminer ce cours.',
      questions: 'Questions',
      passingScore: 'Note de passage',
      attempts: 'Tentatives',
      unlimitedAttempts: 'Tentatives illimitées',
      attemptCount: 'Tentative {current} sur {max}',
      start: 'Commencer l\'évaluation',
      questionNumber: 'Question {number}',
      answeredCount: '{answered} sur {total}',
      submit: 'Soumettre l\'évaluation',
      congratulations: 'Félicitations!',
      notPassed: 'Évaluation non réussie',
      successMessage: 'Vous avez complété l\'évaluation avec succès.',
      failRetryMessage: 'Vous n\'avez pas atteint la note de passage. Vous pouvez réessayer.',
      noAttemptsMessage: 'Vous avez utilisé toutes les tentatives disponibles.',
      scoreDisplay: '{correct} sur {total}',
      tryAgain: 'Réessayer',
      alreadyComplete: 'Évaluation terminée',
      alreadyCompleteMessage: 'Vous avez déjà complété cette évaluation avec succès.',
      lockedTitle: 'Évaluation verrouillée',
      lockedMessage: 'Vous avez utilisé toutes les tentatives disponibles et n\'avez pas atteint la note de passage.',
      bestScore: 'Meilleur résultat',
    },
    quiz: {
      selectAll: 'Cochez toutes les réponses qui s\'appliquent',
      answerOptions: 'Options de réponse',
      submit: 'Soumettre',
      answerRecorded: 'Réponse enregistrée',
      typeAnswer: 'Tapez votre réponse...',
      answerInput: 'Votre réponse',
      correctAnswer: 'La bonne réponse est : {answer}',
      attemptCount: 'Tentative {current} sur {max}',
    },
    media: {
      playNarration: 'Lire la narration',
      youtubeVideo: 'Vidéo YouTube',
      vimeoVideo: 'Vidéo Vimeo',
      googleDriveVideo: 'Vidéo Google Drive',
      synthesiaVideo: 'Vidéo Synthesia',
      loomVideo: 'Vidéo Loom',
      embeddedContent: 'Contenu intégré',
      showTranscript: 'Afficher la transcription',
      hideTranscript: 'Masquer la transcription',
    },
    tabs: {
      contentTabs: 'Onglets de contenu',
    },
    error: {
      loadingCourse: 'Erreur lors du chargement du contenu du cours.',
      noLesson: 'Aucune leçon trouvée.',
      unsupportedBlock: 'Type de bloc non pris en charge: {type}',
    },
    loading: {
      text: 'Chargement...',
    },
    search: {
      placeholder: 'Rechercher...',
      clear: 'Effacer la recherche',
      noResults: 'Aucun résultat pour « {query} »',
      resultsCount: '{count} résultats',
    },
    hotspot: {
      close: 'Fermer',
    },
    conclusion: {
      continue: 'Continuer',
      courseComplete: 'Cours terminé',
    },
    cover: {
      begin: 'Commencer le cours',
      defaultMenuLabel: 'Bienvenue',
      estimatedDuration: '{minutes} min',
      lesson: '{count} leçon',
      lessons: '{count} leçons'
    },
  },
  es: {
    a11y: {
      carouselPrev: 'Tarjetas anteriores',
      carouselNext: 'Tarjetas siguientes',
      flipCarouselPrev: 'Tarjeta anterior',
      flipCarouselNext: 'Tarjeta siguiente',
      goToSlide: 'Ir a la diapositiva {number}',
      flipCardHint: 'Voltear tarjeta. Pulsa Intro o haz clic para voltear.',
      flipHint: 'Haz clic para voltear',
      flipHintBack: 'Haz clic para volver',
      dataTable: 'Tabla de datos',
      courseProgress: 'Progreso del curso',
      hotspot: 'Punto interactivo {number}',
    },
    nav: {
      previous: 'Anterior',
      next: 'Siguiente',
      progress: '{percent}% Completado',
      courseMenu: 'Menú del curso',
      skipToContent: 'Saltar al contenido principal',
      toggleNav: 'Alternar navegación',
      openMenu: 'Abrir menú de navegación',
      closeMenu: 'Cerrar menú de navegación',
      previousLesson: 'Lección anterior',
      nextLesson: 'Siguiente lección',
      upNext: 'A continuación',
      lessonProgress: 'Lección {current} de {total}',
      courseComplete: 'Has llegado al final',
      finalLesson: 'Última lección',
      locked: 'Complete las lecciones anteriores para desbloquear',
      completeScroll: 'Llega al final de esta lección para continuar.',
      completeQuestions: 'Responde las preguntas de esta lección para continuar.',
      completeInteractions: 'Abre todas las actividades de esta página para continuar.',
      completePacing: 'Disponible en {time}',
      exitCourse: 'Salir del curso',
      exitFallbackTitle: 'Progreso del curso guardado',
      exitFallbackMessage: 'Ya puedes cerrar esta pestaña.',
    },
    language: {
      select: 'Seleccionar idioma',
    },
    settings: {
      open: 'Configuración',
      title: 'Configuración',
      close: 'Cerrar',
      display: 'Pantalla',
      language: 'Idioma',
      highContrast: 'Alto contraste',
      highContrastDesc: 'Aumenta el contraste para leer con mayor facilidad',
      highContrastOn: 'Alto contraste activado',
      highContrastOff: 'Alto contraste desactivado',
      textSize: 'Tamaño del texto',
      textSizeIncrease: 'Aumentar el tamaño del texto',
      textSizeDecrease: 'Reducir el tamaño del texto',
      textSizeReset: 'Restablecer el tamaño del texto',
      textSizeAnnounce: 'Tamaño del texto {percent}%',
    },
    assessment: {
      takeAssessment: 'Realizar evaluación',
      completed: 'Completado',
      locked: 'Bloqueado',
      title: 'Evaluación',
      description: 'Complete la siguiente evaluación para finalizar este curso.',
      questions: 'Preguntas',
      passingScore: 'Puntuación mínima',
      attempts: 'Intentos',
      unlimitedAttempts: 'Intentos ilimitados',
      attemptCount: 'Intento {current} de {max}',
      start: 'Comenzar evaluación',
      questionNumber: 'Pregunta {number}',
      answeredCount: '{answered} de {total} respondidas',
      submit: 'Enviar evaluación',
      congratulations: '¡Felicitaciones!',
      notPassed: 'Evaluación no aprobada',
      successMessage: 'Ha completado la evaluación exitosamente.',
      failRetryMessage: 'No alcanzó la puntuación mínima. Puede intentarlo de nuevo.',
      noAttemptsMessage: 'Ha utilizado todos los intentos disponibles.',
      scoreDisplay: '{correct} de {total} correctas',
      tryAgain: 'Intentar de nuevo',
      alreadyComplete: 'Evaluación completada',
      alreadyCompleteMessage: 'Ya ha completado esta evaluación exitosamente.',
      lockedTitle: 'Evaluación bloqueada',
      lockedMessage: 'Ha utilizado todos los intentos disponibles y no alcanzó la puntuación mínima.',
      bestScore: 'Mejor puntuación obtenida',
    },
    quiz: {
      selectAll: 'Seleccione todas las que apliquen',
      answerOptions: 'Opciones de respuesta',
      submit: 'Enviar',
      answerRecorded: 'Respuesta registrada',
      typeAnswer: 'Escriba su respuesta...',
      answerInput: 'Su respuesta',
      correctAnswer: 'La respuesta correcta es: {answer}',
      attemptCount: 'Intento {current} de {max}',
    },
    media: {
      playNarration: 'Reproducir narración',
      youtubeVideo: 'Video de YouTube',
      vimeoVideo: 'Video de Vimeo',
      googleDriveVideo: 'Video de Google Drive',
      synthesiaVideo: 'Video de Synthesia',
      loomVideo: 'Video de Loom',
      embeddedContent: 'Contenido incrustado',
      showTranscript: 'Mostrar transcripción',
      hideTranscript: 'Ocultar transcripción',
    },
    tabs: {
      contentTabs: 'Pestañas de contenido',
    },
    error: {
      loadingCourse: 'Error al cargar el contenido del curso.',
      noLesson: 'No se encontró la lección.',
      unsupportedBlock: 'Tipo de bloque no compatible: {type}',
    },
    loading: {
      text: 'Cargando...',
    },
    search: {
      placeholder: 'Buscar en el curso...',
      clear: 'Borrar búsqueda',
      noResults: 'Sin resultados para "{query}"',
      resultsCount: '{count} resultados',
    },
    hotspot: {
      close: 'Cerrar',
    },
    conclusion: {
      continue: 'Continuar',
      courseComplete: 'Curso completado',
    },
    cover: {
      begin: 'Comenzar el curso',
      defaultMenuLabel: 'Bienvenido',
      estimatedDuration: '{minutes} min',
      lesson: '{count} lección',
      lessons: '{count} lecciones'
    },
  },
  da: {
    a11y: {
      carouselPrev: 'Forrige kort',
      carouselNext: 'Næste kort',
      flipCarouselPrev: 'Forrige kort',
      flipCarouselNext: 'Næste kort',
      goToSlide: 'Gå til dias {number}',
      flipCardHint: 'Vend kort. Tryk Enter eller klik for at vende.',
      flipHint: 'Klik for at vende',
      flipHintBack: 'Klik for at vende tilbage',
      dataTable: 'Datatabel',
      courseProgress: 'Kursusfremskridt',
      hotspot: 'Interaktivt punkt {number}',
    },
    nav: {
      previous: 'Forrige',
      next: 'Næste',
      progress: '{percent}% Gennemført',
      courseMenu: 'Kursusmenu',
      skipToContent: 'Spring til hovedindhold',
      toggleNav: 'Skift navigation',
      openMenu: 'Åbn navigationsmenu',
      closeMenu: 'Luk navigationsmenu',
      previousLesson: 'Forrige lektion',
      nextLesson: 'Næste lektion',
      upNext: 'Næste',
      lessonProgress: 'Lektion {current} af {total}',
      courseComplete: 'Du har nået slutningen',
      finalLesson: 'Sidste lektion',
      locked: 'Gennemfør tidligere lektioner for at låse op',
      completeScroll: 'Nå til slutningen af denne lektion for at fortsætte.',
      completeQuestions: 'Besvar denne lektions spørgsmål for at fortsætte.',
      completeInteractions: 'Åbn alle aktiviteter på denne side for at fortsætte.',
      completePacing: 'Tilgængelig om {time}',
      exitCourse: 'Afslut kursus',
      exitFallbackTitle: 'Kursusfremdrift gemt',
      exitFallbackMessage: 'Du kan nu lukke denne fane.',
    },
    language: {
      select: 'Vælg sprog',
    },
    settings: {
      open: 'Indstillinger',
      title: 'Indstillinger',
      close: 'Luk',
      display: 'Skærm',
      language: 'Sprog',
      highContrast: 'Høj kontrast',
      highContrastDesc: 'Øg kontrasten for lettere læsning',
      highContrastOn: 'Høj kontrast til',
      highContrastOff: 'Høj kontrast fra',
      textSize: 'Tekststørrelse',
      textSizeIncrease: 'Forstør tekst',
      textSizeDecrease: 'Formindsk tekst',
      textSizeReset: 'Nulstil tekststørrelse',
      textSizeAnnounce: 'Tekststørrelse {percent}%',
    },
    assessment: {
      takeAssessment: 'Tag testen',
      completed: 'Gennemført',
      locked: 'Låst',
      title: 'Test',
      description: 'Gennemfør følgende test for at afslutte dette kursus.',
      questions: 'Spørgsmål',
      passingScore: 'Beståelsesgrænse',
      attempts: 'Forsøg',
      unlimitedAttempts: 'Ubegrænsede forsøg',
      attemptCount: 'Forsøg {current} af {max}',
      start: 'Start test',
      questionNumber: 'Spørgsmål {number}',
      answeredCount: '{answered} af {total} besvaret',
      submit: 'Indsend test',
      congratulations: 'Tillykke!',
      notPassed: 'Test ikke bestået',
      successMessage: 'Du har gennemført testen.',
      failRetryMessage: 'Du opnåede ikke beståelsesgrænsen. Du kan prøve igen.',
      noAttemptsMessage: 'Du har brugt alle tilgængelige forsøg.',
      scoreDisplay: '{correct} af {total} korrekte',
      tryAgain: 'Prøv igen',
      alreadyComplete: 'Test gennemført',
      alreadyCompleteMessage: 'Du har allerede gennemført denne test.',
      lockedTitle: 'Test låst',
      lockedMessage: 'Du har brugt alle tilgængelige forsøg og har ikke opnået beståelsesgrænsen.',
      bestScore: 'Bedste opnåede resultat',
    },
    quiz: {
      selectAll: 'Vælg alle der passer',
      answerOptions: 'Svarmuligheder',
      submit: 'Indsend',
      answerRecorded: 'Svar registreret',
      typeAnswer: 'Skriv dit svar...',
      answerInput: 'Dit svar',
      correctAnswer: 'Det rigtige svar er: {answer}',
      attemptCount: 'Forsøg {current} af {max}',
    },
    media: {
      playNarration: 'Afspil fortælling',
      youtubeVideo: 'YouTube-video',
      vimeoVideo: 'Vimeo-video',
      googleDriveVideo: 'Google Drev-video',
      synthesiaVideo: 'Synthesia-video',
      loomVideo: 'Loom-video',
      embeddedContent: 'Indlejret indhold',
      showTranscript: 'Vis transskription',
      hideTranscript: 'Skjul transskription',
    },
    tabs: {
      contentTabs: 'Indholdsfaner',
    },
    error: {
      loadingCourse: 'Fejl ved indlæsning af kursusindhold.',
      noLesson: 'Ingen lektion fundet.',
      unsupportedBlock: 'Ikke-understøttet bloktype: {type}',
    },
    loading: {
      text: 'Indlæser...',
    },
    search: {
      placeholder: 'Søg i kursus...',
      clear: 'Ryd søgning',
      noResults: 'Ingen resultater for "{query}"',
      resultsCount: '{count} resultater',
    },
    hotspot: {
      close: 'Luk',
    },
    conclusion: {
      continue: 'Fortsæt',
      courseComplete: 'Kursus afsluttet',
    },
    cover: {
      begin: 'Start kurset',
      defaultMenuLabel: 'Velkommen',
      estimatedDuration: '{minutes} min.',
      lesson: '{count} lektion',
      lessons: '{count} lektioner'
    },
  },
  nl: {
    a11y: {
      carouselPrev: 'Vorige kaarten',
      carouselNext: 'Volgende kaarten',
      flipCarouselPrev: 'Vorige kaart',
      flipCarouselNext: 'Volgende kaart',
      goToSlide: 'Ga naar dia {number}',
      flipCardHint: 'Kaart omdraaien. Druk op Enter of klik om om te draaien.',
      flipHint: 'Klik om om te draaien',
      flipHintBack: 'Klik om terug te draaien',
      dataTable: 'Gegevenstabel',
      courseProgress: 'Cursusvoortgang',
      hotspot: 'Interactief punt {number}',
    },
    nav: {
      previous: 'Vorige',
      next: 'Volgende',
      progress: '{percent}% Voltooid',
      courseMenu: 'Cursusmenu',
      skipToContent: 'Ga naar hoofdinhoud',
      toggleNav: 'Navigatie wisselen',
      openMenu: 'Navigatiemenu openen',
      closeMenu: 'Navigatiemenu sluiten',
      previousLesson: 'Vorige les',
      nextLesson: 'Volgende les',
      upNext: 'Volgende',
      lessonProgress: 'Les {current} van {total}',
      courseComplete: 'Je hebt het einde bereikt',
      finalLesson: 'Laatste les',
      locked: 'Voltooi vorige lessen om te ontgrendelen',
      completeScroll: 'Ga naar het einde van deze les om verder te gaan.',
      completeQuestions: 'Beantwoord de vragen van deze les om verder te gaan.',
      completeInteractions: 'Open elke activiteit op deze pagina om verder te gaan.',
      completePacing: 'Beschikbaar over {time}',
      exitCourse: 'Cursus verlaten',
      exitFallbackTitle: 'Cursusvoortgang opgeslagen',
      exitFallbackMessage: 'Je kunt dit tabblad nu sluiten.',
    },
    language: {
      select: 'Taal selecteren',
    },
    settings: {
      open: 'Instellingen',
      title: 'Instellingen',
      close: 'Sluiten',
      display: 'Weergave',
      language: 'Taal',
      highContrast: 'Hoog contrast',
      highContrastDesc: 'Verhoog het contrast om makkelijker te lezen',
      highContrastOn: 'Hoog contrast aan',
      highContrastOff: 'Hoog contrast uit',
      textSize: 'Tekstgrootte',
      textSizeIncrease: 'Tekst vergroten',
      textSizeDecrease: 'Tekst verkleinen',
      textSizeReset: 'Tekstgrootte herstellen',
      textSizeAnnounce: 'Tekstgrootte {percent}%',
    },
    assessment: {
      takeAssessment: 'Toets maken',
      completed: 'Voltooid',
      locked: 'Vergrendeld',
      title: 'Toets',
      description: 'Voltooi de volgende toets om deze cursus af te ronden.',
      questions: 'Vragen',
      passingScore: 'Slagingsgrens',
      attempts: 'Pogingen',
      unlimitedAttempts: 'Onbeperkt aantal pogingen',
      attemptCount: 'Poging {current} van {max}',
      start: 'Toets starten',
      questionNumber: 'Vraag {number}',
      answeredCount: '{answered} van {total} beantwoord',
      submit: 'Toets indienen',
      congratulations: 'Gefeliciteerd!',
      notPassed: 'Toets niet gehaald',
      successMessage: 'U heeft de toets succesvol afgerond.',
      failRetryMessage: 'U heeft de slagingsgrens niet gehaald. U kunt het opnieuw proberen.',
      noAttemptsMessage: 'U heeft alle beschikbare pogingen gebruikt.',
      scoreDisplay: '{correct} van {total} correct',
      tryAgain: 'Opnieuw proberen',
      alreadyComplete: 'Toets voltooid',
      alreadyCompleteMessage: 'U heeft deze toets al succesvol afgerond.',
      lockedTitle: 'Toets vergrendeld',
      lockedMessage: 'U heeft alle beschikbare pogingen gebruikt en de slagingsgrens niet gehaald.',
      bestScore: 'Beste behaalde score',
    },
    quiz: {
      selectAll: 'Selecteer alle juiste antwoorden',
      answerOptions: 'Antwoordopties',
      submit: 'Indienen',
      answerRecorded: 'Antwoord geregistreerd',
      typeAnswer: 'Typ uw antwoord...',
      answerInput: 'Uw antwoord',
      correctAnswer: 'Het juiste antwoord is: {answer}',
      attemptCount: 'Poging {current} van {max}',
    },
    media: {
      playNarration: 'Vertelling afspelen',
      youtubeVideo: 'YouTube-video',
      vimeoVideo: 'Vimeo-video',
      googleDriveVideo: 'Google Drive-video',
      synthesiaVideo: 'Synthesia-video',
      loomVideo: 'Loom-video',
      embeddedContent: 'Ingesloten inhoud',
      showTranscript: 'Transcript tonen',
      hideTranscript: 'Transcript verbergen',
    },
    tabs: {
      contentTabs: 'Inhoudstabbladen',
    },
    error: {
      loadingCourse: 'Fout bij het laden van de cursusinhoud.',
      noLesson: 'Geen les gevonden.',
      unsupportedBlock: 'Niet-ondersteund bloktype: {type}',
    },
    loading: {
      text: 'Laden...',
    },
    search: {
      placeholder: 'Zoeken in cursus...',
      clear: 'Zoekopdracht wissen',
      noResults: 'Geen resultaten voor "{query}"',
      resultsCount: '{count} resultaten',
    },
    hotspot: {
      close: 'Sluiten',
    },
    conclusion: {
      continue: 'Doorgaan',
      courseComplete: 'Cursus voltooid',
    },
    cover: {
      begin: 'Cursus starten',
      defaultMenuLabel: 'Welkom',
      estimatedDuration: '{minutes} min',
      lesson: '{count} les',
      lessons: '{count} lessen'
    },
  },
  fr: {
    a11y: {
      carouselPrev: 'Cartes précédentes',
      carouselNext: 'Cartes suivantes',
      flipCarouselPrev: 'Carte précédente',
      flipCarouselNext: 'Carte suivante',
      goToSlide: 'Aller à la diapositive {number}',
      flipCardHint: 'Retourner la carte. Appuyez sur Entrée ou cliquez pour retourner.',
      flipHint: 'Cliquez pour retourner',
      flipHintBack: 'Cliquez pour revenir',
      dataTable: 'Tableau de données',
      courseProgress: 'Progression du cours',
      hotspot: 'Point interactif {number}',
    },
    nav: {
      previous: 'Précédent',
      next: 'Suivant',
      progress: '{percent}% Terminé',
      courseMenu: 'Menu du cours',
      skipToContent: 'Passer au contenu principal',
      toggleNav: 'Basculer la navigation',
      openMenu: 'Ouvrir le menu de navigation',
      closeMenu: 'Fermer le menu de navigation',
      previousLesson: 'Leçon précédente',
      nextLesson: 'Leçon suivante',
      upNext: 'À suivre',
      lessonProgress: 'Leçon {current} de {total}',
      courseComplete: 'Vous avez atteint la fin',
      finalLesson: 'Dernière leçon',
      locked: 'Terminez les leçons précédentes pour débloquer',
      completeScroll: 'Atteignez la fin de cette leçon pour continuer.',
      completeQuestions: 'Répondez aux questions de cette leçon pour continuer.',
      completeInteractions: 'Ouvrez chaque activité de cette page pour continuer.',
      completePacing: 'Disponible dans {time}',
      exitCourse: 'Quitter le cours',
      exitFallbackTitle: 'Progression sauvegardée',
      exitFallbackMessage: 'Vous pouvez maintenant fermer cet onglet.',
    },
    language: {
      select: 'Sélectionner la langue',
    },
    settings: {
      open: 'Paramètres',
      title: 'Paramètres',
      close: 'Fermer',
      display: 'Affichage',
      language: 'Langue',
      highContrast: 'Contraste élevé',
      highContrastDesc: 'Augmente le contraste pour une lecture plus facile',
      highContrastOn: 'Contraste élevé activé',
      highContrastOff: 'Contraste élevé désactivé',
      textSize: 'Taille du texte',
      textSizeIncrease: 'Augmenter la taille du texte',
      textSizeDecrease: 'Réduire la taille du texte',
      textSizeReset: 'Réinitialiser la taille du texte',
      textSizeAnnounce: 'Taille du texte {percent} %',
    },
    assessment: {
      takeAssessment: 'Passer l\'évaluation',
      completed: 'Terminé',
      locked: 'Verrouillé',
      title: 'Évaluation',
      description: 'Complétez l\'évaluation suivante pour terminer ce cours.',
      questions: 'Questions',
      passingScore: 'Note de passage',
      attempts: 'Tentatives',
      unlimitedAttempts: 'Tentatives illimitées',
      attemptCount: 'Tentative {current} sur {max}',
      start: 'Commencer l\'évaluation',
      questionNumber: 'Question {number}',
      answeredCount: '{answered} sur {total} répondu',
      submit: 'Soumettre l\'évaluation',
      congratulations: 'Félicitations !',
      notPassed: 'Évaluation non réussie',
      successMessage: 'Vous avez terminé l\'évaluation avec succès.',
      failRetryMessage: 'Vous n\'avez pas atteint la note de passage. Vous pouvez réessayer.',
      noAttemptsMessage: 'Vous avez utilisé toutes les tentatives disponibles.',
      scoreDisplay: '{correct} sur {total} correct',
      tryAgain: 'Réessayer',
      alreadyComplete: 'Évaluation terminée',
      alreadyCompleteMessage: 'Vous avez déjà terminé cette évaluation avec succès.',
      lockedTitle: 'Évaluation verrouillée',
      lockedMessage: 'Vous avez utilisé toutes les tentatives disponibles et n\'avez pas atteint la note de passage.',
      bestScore: 'Meilleur score obtenu',
    },
    quiz: {
      selectAll: 'Sélectionnez toutes les réponses applicables',
      answerOptions: 'Options de réponse',
      submit: 'Soumettre',
      answerRecorded: 'Réponse enregistrée',
      typeAnswer: 'Tapez votre réponse...',
      answerInput: 'Votre réponse',
      correctAnswer: 'La bonne réponse est : {answer}',
      attemptCount: 'Tentative {current} sur {max}',
    },
    media: {
      playNarration: 'Lire la narration',
      youtubeVideo: 'Vidéo YouTube',
      vimeoVideo: 'Vidéo Vimeo',
      googleDriveVideo: 'Vidéo Google Drive',
      synthesiaVideo: 'Vidéo Synthesia',
      loomVideo: 'Vidéo Loom',
      embeddedContent: 'Contenu intégré',
      showTranscript: 'Afficher la transcription',
      hideTranscript: 'Masquer la transcription',
    },
    tabs: {
      contentTabs: 'Onglets de contenu',
    },
    error: {
      loadingCourse: 'Erreur lors du chargement du contenu du cours.',
      noLesson: 'Aucune leçon trouvée.',
      unsupportedBlock: 'Type de bloc non pris en charge : {type}',
    },
    loading: {
      text: 'Chargement...',
    },
    search: {
      placeholder: 'Rechercher dans le cours...',
      clear: 'Effacer la recherche',
      noResults: 'Aucun résultat pour « {query} »',
      resultsCount: '{count} résultats',
    },
    hotspot: {
      close: 'Fermer',
    },
    conclusion: {
      continue: 'Continuer',
      courseComplete: 'Cours terminé',
    },
    cover: {
      begin: 'Commencer le cours',
      defaultMenuLabel: 'Bienvenue',
      estimatedDuration: '{minutes} min',
      lesson: '{count} leçon',
      lessons: '{count} leçons'
    },
  },
  de: {
    a11y: {
      carouselPrev: 'Vorherige Karten',
      carouselNext: 'Nächste Karten',
      flipCarouselPrev: 'Vorherige Karte',
      flipCarouselNext: 'Nächste Karte',
      goToSlide: 'Zu Folie {number} springen',
      flipCardHint: 'Karte umdrehen. Drücken Sie die Eingabetaste oder klicken Sie zum Umdrehen.',
      flipHint: 'Zum Umdrehen klicken',
      flipHintBack: 'Zum Zurückdrehen klicken',
      dataTable: 'Datentabelle',
      courseProgress: 'Kursfortschritt',
      hotspot: 'Interaktiver Punkt {number}',
    },
    nav: {
      previous: 'Zurück',
      next: 'Weiter',
      progress: '{percent}% Abgeschlossen',
      courseMenu: 'Kursmenü',
      skipToContent: 'Zum Hauptinhalt springen',
      toggleNav: 'Navigation umschalten',
      openMenu: 'Navigationsmenü öffnen',
      closeMenu: 'Navigationsmenü schließen',
      previousLesson: 'Vorherige Lektion',
      nextLesson: 'Nächste Lektion',
      upNext: 'Als Nächstes',
      lessonProgress: 'Lektion {current} von {total}',
      courseComplete: 'Sie haben das Ende erreicht',
      finalLesson: 'Letzte Lektion',
      locked: 'Schließen Sie vorherige Lektionen ab, um freizuschalten',
      completeScroll: 'Scrollen Sie ans Ende dieser Lektion, um fortzufahren.',
      completeQuestions: 'Beantworten Sie die Fragen dieser Lektion, um fortzufahren.',
      completeInteractions: 'Öffnen Sie jede Aktivität auf dieser Seite, um fortzufahren.',
      completePacing: 'Verfügbar in {time}',
      exitCourse: 'Kurs beenden',
      exitFallbackTitle: 'Kursfortschritt gespeichert',
      exitFallbackMessage: 'Sie können diesen Tab jetzt schließen.',
    },
    language: {
      select: 'Sprache auswählen',
    },
    settings: {
      open: 'Einstellungen',
      title: 'Einstellungen',
      close: 'Schließen',
      display: 'Anzeige',
      language: 'Sprache',
      highContrast: 'Hoher Kontrast',
      highContrastDesc: 'Erhöht den Kontrast für leichteres Lesen',
      highContrastOn: 'Hoher Kontrast ein',
      highContrastOff: 'Hoher Kontrast aus',
      textSize: 'Textgröße',
      textSizeIncrease: 'Textgröße erhöhen',
      textSizeDecrease: 'Textgröße verringern',
      textSizeReset: 'Textgröße zurücksetzen',
      textSizeAnnounce: 'Textgröße {percent} %',
    },
    assessment: {
      takeAssessment: 'Prüfung ablegen',
      completed: 'Abgeschlossen',
      locked: 'Gesperrt',
      title: 'Prüfung',
      description: 'Absolvieren Sie die folgende Prüfung, um diesen Kurs abzuschließen.',
      questions: 'Fragen',
      passingScore: 'Bestehensgrenze',
      attempts: 'Versuche',
      unlimitedAttempts: 'Unbegrenzte Versuche',
      attemptCount: 'Versuch {current} von {max}',
      start: 'Prüfung starten',
      questionNumber: 'Frage {number}',
      answeredCount: '{answered} von {total} beantwortet',
      submit: 'Prüfung abgeben',
      congratulations: 'Herzlichen Glückwunsch!',
      notPassed: 'Prüfung nicht bestanden',
      successMessage: 'Sie haben die Prüfung erfolgreich abgeschlossen.',
      failRetryMessage: 'Sie haben die Bestehensgrenze nicht erreicht. Sie können es erneut versuchen.',
      noAttemptsMessage: 'Sie haben alle verfügbaren Versuche aufgebraucht.',
      scoreDisplay: '{correct} von {total} richtig',
      tryAgain: 'Erneut versuchen',
      alreadyComplete: 'Prüfung abgeschlossen',
      alreadyCompleteMessage: 'Sie haben diese Prüfung bereits erfolgreich abgeschlossen.',
      lockedTitle: 'Prüfung gesperrt',
      lockedMessage: 'Sie haben alle verfügbaren Versuche aufgebraucht und die Bestehensgrenze nicht erreicht.',
      bestScore: 'Bestes erreichtes Ergebnis',
    },
    quiz: {
      selectAll: 'Alle zutreffenden Antworten auswählen',
      answerOptions: 'Antwortmöglichkeiten',
      submit: 'Absenden',
      answerRecorded: 'Antwort gespeichert',
      typeAnswer: 'Geben Sie Ihre Antwort ein...',
      answerInput: 'Ihre Antwort',
      correctAnswer: 'Die richtige Antwort ist: {answer}',
      attemptCount: 'Versuch {current} von {max}',
    },
    media: {
      playNarration: 'Erzählung abspielen',
      youtubeVideo: 'YouTube-Video',
      vimeoVideo: 'Vimeo-Video',
      googleDriveVideo: 'Google Drive-Video',
      synthesiaVideo: 'Synthesia-Video',
      loomVideo: 'Loom-Video',
      embeddedContent: 'Eingebetteter Inhalt',
      showTranscript: 'Transkript anzeigen',
      hideTranscript: 'Transkript ausblenden',
    },
    tabs: {
      contentTabs: 'Inhaltsregisterkarten',
    },
    error: {
      loadingCourse: 'Fehler beim Laden des Kursinhalts.',
      noLesson: 'Keine Lektion gefunden.',
      unsupportedBlock: 'Nicht unterstützter Blocktyp: {type}',
    },
    loading: {
      text: 'Wird geladen...',
    },
    search: {
      placeholder: 'Kurs durchsuchen...',
      clear: 'Suche löschen',
      noResults: 'Keine Ergebnisse für „{query}"',
      resultsCount: '{count} Ergebnisse',
    },
    hotspot: {
      close: 'Schließen',
    },
    conclusion: {
      continue: 'Weiter',
      courseComplete: 'Kurs abgeschlossen',
    },
    cover: {
      begin: 'Kurs beginnen',
      defaultMenuLabel: 'Willkommen',
      estimatedDuration: '{minutes} Min.',
      lesson: '{count} Lektion',
      lessons: '{count} Lektionen'
    },
  },
  it: {
    a11y: {
      carouselPrev: 'Schede precedenti',
      carouselNext: 'Schede successive',
      flipCarouselPrev: 'Scheda precedente',
      flipCarouselNext: 'Scheda successiva',
      goToSlide: 'Vai alla diapositiva {number}',
      flipCardHint: 'Gira la scheda. Premi Invio o fai clic per girarla.',
      flipHint: 'Fai clic per girare',
      flipHintBack: 'Fai clic per tornare',
      dataTable: 'Tabella di dati',
      courseProgress: 'Avanzamento del corso',
      hotspot: 'Punto interattivo {number}',
    },
    nav: {
      previous: 'Precedente',
      next: 'Successivo',
      progress: '{percent}% Completato',
      courseMenu: 'Menu del corso',
      skipToContent: 'Vai al contenuto principale',
      toggleNav: 'Attiva/disattiva navigazione',
      openMenu: 'Apri menu di navigazione',
      closeMenu: 'Chiudi menu di navigazione',
      previousLesson: 'Lezione precedente',
      nextLesson: 'Prossima lezione',
      upNext: 'Prossimo',
      lessonProgress: 'Lezione {current} di {total}',
      courseComplete: 'Hai raggiunto la fine',
      finalLesson: 'Ultima lezione',
      locked: 'Completa le lezioni precedenti per sbloccare',
      completeScroll: 'Raggiungi la fine di questa lezione per continuare.',
      completeQuestions: 'Rispondi alle domande di questa lezione per continuare.',
      completeInteractions: 'Apri tutte le attività di questa pagina per continuare.',
      completePacing: 'Disponibile tra {time}',
      exitCourse: 'Esci dal corso',
      exitFallbackTitle: 'Progressi del corso salvati',
      exitFallbackMessage: 'Ora puoi chiudere questa scheda.',
    },
    language: {
      select: 'Seleziona lingua',
    },
    settings: {
      open: 'Impostazioni',
      title: 'Impostazioni',
      close: 'Chiudi',
      display: 'Schermo',
      language: 'Lingua',
      highContrast: 'Contrasto elevato',
      highContrastDesc: 'Aumenta il contrasto per leggere più facilmente',
      highContrastOn: 'Contrasto elevato attivato',
      highContrastOff: 'Contrasto elevato disattivato',
      textSize: 'Dimensione del testo',
      textSizeIncrease: 'Aumenta la dimensione del testo',
      textSizeDecrease: 'Riduci la dimensione del testo',
      textSizeReset: 'Reimposta la dimensione del testo',
      textSizeAnnounce: 'Dimensione del testo {percent}%',
    },
    assessment: {
      takeAssessment: 'Sostieni la verifica',
      completed: 'Completato',
      locked: 'Bloccato',
      title: 'Verifica',
      description: 'Completa la seguente verifica per terminare questo corso.',
      questions: 'Domande',
      passingScore: 'Punteggio minimo',
      attempts: 'Tentativi',
      unlimitedAttempts: 'Tentativi illimitati',
      attemptCount: 'Tentativo {current} di {max}',
      start: 'Inizia verifica',
      questionNumber: 'Domanda {number}',
      answeredCount: '{answered} di {total} risposte date',
      submit: 'Invia verifica',
      congratulations: 'Congratulazioni!',
      notPassed: 'Verifica non superata',
      successMessage: 'Hai completato la verifica con successo.',
      failRetryMessage: 'Non hai raggiunto il punteggio minimo. Puoi riprovare.',
      noAttemptsMessage: 'Hai esaurito tutti i tentativi disponibili.',
      scoreDisplay: '{correct} di {total} corrette',
      tryAgain: 'Riprova',
      alreadyComplete: 'Verifica completata',
      alreadyCompleteMessage: 'Hai già completato questa verifica con successo.',
      lockedTitle: 'Verifica bloccata',
      lockedMessage: 'Hai esaurito tutti i tentativi disponibili e non hai raggiunto il punteggio minimo.',
      bestScore: 'Miglior punteggio ottenuto',
    },
    quiz: {
      selectAll: 'Seleziona tutte le risposte corrette',
      answerOptions: 'Opzioni di risposta',
      submit: 'Invia',
      answerRecorded: 'Risposta registrata',
      typeAnswer: 'Digita la tua risposta...',
      answerInput: 'La tua risposta',
      correctAnswer: 'La risposta corretta è: {answer}',
      attemptCount: 'Tentativo {current} di {max}',
    },
    media: {
      playNarration: 'Riproduci narrazione',
      youtubeVideo: 'Video YouTube',
      vimeoVideo: 'Video Vimeo',
      googleDriveVideo: 'Video Google Drive',
      synthesiaVideo: 'Video Synthesia',
      loomVideo: 'Video Loom',
      embeddedContent: 'Contenuto incorporato',
      showTranscript: 'Mostra trascrizione',
      hideTranscript: 'Nascondi trascrizione',
    },
    tabs: {
      contentTabs: 'Schede di contenuto',
    },
    error: {
      loadingCourse: 'Errore durante il caricamento del contenuto del corso.',
      noLesson: 'Nessuna lezione trovata.',
      unsupportedBlock: 'Tipo di blocco non supportato: {type}',
    },
    loading: {
      text: 'Caricamento...',
    },
    search: {
      placeholder: 'Cerca nel corso...',
      clear: 'Cancella ricerca',
      noResults: 'Nessun risultato per "{query}"',
      resultsCount: '{count} risultati',
    },
    hotspot: {
      close: 'Chiudi',
    },
    conclusion: {
      continue: 'Continua',
      courseComplete: 'Corso completato',
    },
    cover: {
      begin: 'Inizia il corso',
      defaultMenuLabel: 'Benvenuto',
      estimatedDuration: '{minutes} min',
      lesson: '{count} lezione',
      lessons: '{count} lezioni'
    },
  },
  'pt-BR': {
    a11y: {
      carouselPrev: 'Cartões anteriores',
      carouselNext: 'Próximos cartões',
      flipCarouselPrev: 'Cartão anterior',
      flipCarouselNext: 'Próximo cartão',
      goToSlide: 'Ir para o slide {number}',
      flipCardHint: 'Virar cartão. Pressione Enter ou clique para virar.',
      flipHint: 'Clique para virar',
      flipHintBack: 'Clique para voltar',
      dataTable: 'Tabela de dados',
      courseProgress: 'Progresso do curso',
      hotspot: 'Ponto interativo {number}',
    },
    nav: {
      previous: 'Anterior',
      next: 'Próximo',
      progress: '{percent}% Concluído',
      courseMenu: 'Menu do curso',
      skipToContent: 'Pular para o conteúdo principal',
      toggleNav: 'Alternar navegação',
      openMenu: 'Abrir menu de navegação',
      closeMenu: 'Fechar menu de navegação',
      previousLesson: 'Lição anterior',
      nextLesson: 'Próxima lição',
      upNext: 'A seguir',
      lessonProgress: 'Lição {current} de {total}',
      courseComplete: 'Você chegou ao final',
      finalLesson: 'Última lição',
      locked: 'Conclua as lições anteriores para desbloquear',
      completeScroll: 'Chegue ao final desta lição para continuar.',
      completeQuestions: 'Responda às perguntas desta lição para continuar.',
      completeInteractions: 'Abra todas as atividades desta página para continuar.',
      completePacing: 'Disponível em {time}',
      exitCourse: 'Sair do curso',
      exitFallbackTitle: 'Progresso do curso salvo',
      exitFallbackMessage: 'Você já pode fechar esta aba.',
    },
    language: {
      select: 'Selecionar idioma',
    },
    settings: {
      open: 'Configurações',
      title: 'Configurações',
      close: 'Fechar',
      display: 'Tela',
      language: 'Idioma',
      highContrast: 'Alto contraste',
      highContrastDesc: 'Aumenta o contraste para facilitar a leitura',
      highContrastOn: 'Alto contraste ativado',
      highContrastOff: 'Alto contraste desativado',
      textSize: 'Tamanho do texto',
      textSizeIncrease: 'Aumentar o tamanho do texto',
      textSizeDecrease: 'Diminuir o tamanho do texto',
      textSizeReset: 'Redefinir o tamanho do texto',
      textSizeAnnounce: 'Tamanho do texto {percent}%',
    },
    assessment: {
      takeAssessment: 'Realizar avaliação',
      completed: 'Concluído',
      locked: 'Bloqueado',
      title: 'Avaliação',
      description: 'Conclua a avaliação a seguir para finalizar este curso.',
      questions: 'Perguntas',
      passingScore: 'Nota mínima',
      attempts: 'Tentativas',
      unlimitedAttempts: 'Tentativas ilimitadas',
      attemptCount: 'Tentativa {current} de {max}',
      start: 'Iniciar avaliação',
      questionNumber: 'Pergunta {number}',
      answeredCount: '{answered} de {total} respondidas',
      submit: 'Enviar avaliação',
      congratulations: 'Parabéns!',
      notPassed: 'Avaliação não aprovada',
      successMessage: 'Você concluiu a avaliação com sucesso.',
      failRetryMessage: 'Você não atingiu a nota mínima. Você pode tentar novamente.',
      noAttemptsMessage: 'Você utilizou todas as tentativas disponíveis.',
      scoreDisplay: '{correct} de {total} corretas',
      tryAgain: 'Tentar novamente',
      alreadyComplete: 'Avaliação concluída',
      alreadyCompleteMessage: 'Você já concluiu esta avaliação com sucesso.',
      lockedTitle: 'Avaliação bloqueada',
      lockedMessage: 'Você utilizou todas as tentativas disponíveis e não atingiu a nota mínima.',
      bestScore: 'Melhor pontuação obtida',
    },
    quiz: {
      selectAll: 'Selecione todas as alternativas corretas',
      answerOptions: 'Opções de resposta',
      submit: 'Enviar',
      answerRecorded: 'Resposta registrada',
      typeAnswer: 'Digite sua resposta...',
      answerInput: 'Sua resposta',
      correctAnswer: 'A resposta correta é: {answer}',
      attemptCount: 'Tentativa {current} de {max}',
    },
    media: {
      playNarration: 'Reproduzir narração',
      youtubeVideo: 'Vídeo do YouTube',
      vimeoVideo: 'Vídeo do Vimeo',
      googleDriveVideo: 'Vídeo do Google Drive',
      synthesiaVideo: 'Vídeo do Synthesia',
      loomVideo: 'Vídeo do Loom',
      embeddedContent: 'Conteúdo incorporado',
      showTranscript: 'Mostrar transcrição',
      hideTranscript: 'Ocultar transcrição',
    },
    tabs: {
      contentTabs: 'Guias de conteúdo',
    },
    error: {
      loadingCourse: 'Erro ao carregar o conteúdo do curso.',
      noLesson: 'Nenhuma lição encontrada.',
      unsupportedBlock: 'Tipo de bloco não suportado: {type}',
    },
    loading: {
      text: 'Carregando...',
    },
    search: {
      placeholder: 'Pesquisar no curso...',
      clear: 'Limpar pesquisa',
      noResults: 'Nenhum resultado para "{query}"',
      resultsCount: '{count} resultados',
    },
    hotspot: {
      close: 'Fechar',
    },
    conclusion: {
      continue: 'Continuar',
      courseComplete: 'Curso concluído',
    },
    cover: {
      begin: 'Começar o curso',
      defaultMenuLabel: 'Bem-vindo',
      estimatedDuration: '{minutes} min',
      lesson: '{count} aula',
      lessons: '{count} aulas'
    },
  },
  'pt-PT': {
    a11y: {
      carouselPrev: 'Cartões anteriores',
      carouselNext: 'Cartões seguintes',
      flipCarouselPrev: 'Cartão anterior',
      flipCarouselNext: 'Cartão seguinte',
      goToSlide: 'Ir para o diapositivo {number}',
      flipCardHint: 'Virar cartão. Prima Enter ou clique para virar.',
      flipHint: 'Clique para virar',
      flipHintBack: 'Clique para voltar',
      dataTable: 'Tabela de dados',
      courseProgress: 'Progresso do curso',
      hotspot: 'Ponto interativo {number}',
    },
    nav: {
      previous: 'Anterior',
      next: 'Seguinte',
      progress: '{percent}% Concluído',
      courseMenu: 'Menu do curso',
      skipToContent: 'Saltar para o conteúdo principal',
      toggleNav: 'Alternar navegação',
      openMenu: 'Abrir menu de navegação',
      closeMenu: 'Fechar menu de navegação',
      previousLesson: 'Lição anterior',
      nextLesson: 'Próxima lição',
      upNext: 'A seguir',
      lessonProgress: 'Lição {current} de {total}',
      courseComplete: 'Chegou ao final',
      finalLesson: 'Última lição',
      locked: 'Conclua as lições anteriores para desbloquear',
      completeScroll: 'Chegue ao final desta lição para continuar.',
      completeQuestions: 'Responda às perguntas desta lição para continuar.',
      completeInteractions: 'Abra todas as atividades desta página para continuar.',
      completePacing: 'Disponível em {time}',
      exitCourse: 'Sair do curso',
      exitFallbackTitle: 'Progresso do curso guardado',
      exitFallbackMessage: 'Já pode fechar este separador.',
    },
    language: {
      select: 'Selecionar idioma',
    },
    settings: {
      open: 'Definições',
      title: 'Definições',
      close: 'Fechar',
      display: 'Ecrã',
      language: 'Idioma',
      highContrast: 'Alto contraste',
      highContrastDesc: 'Aumenta o contraste para facilitar a leitura',
      highContrastOn: 'Alto contraste ativado',
      highContrastOff: 'Alto contraste desativado',
      textSize: 'Tamanho do texto',
      textSizeIncrease: 'Aumentar o tamanho do texto',
      textSizeDecrease: 'Diminuir o tamanho do texto',
      textSizeReset: 'Repor o tamanho do texto',
      textSizeAnnounce: 'Tamanho do texto {percent}%',
    },
    assessment: {
      takeAssessment: 'Realizar avaliação',
      completed: 'Concluído',
      locked: 'Bloqueado',
      title: 'Avaliação',
      description: 'Conclua a avaliação seguinte para terminar este curso.',
      questions: 'Perguntas',
      passingScore: 'Nota mínima',
      attempts: 'Tentativas',
      unlimitedAttempts: 'Tentativas ilimitadas',
      attemptCount: 'Tentativa {current} de {max}',
      start: 'Iniciar avaliação',
      questionNumber: 'Pergunta {number}',
      answeredCount: '{answered} de {total} respondidas',
      submit: 'Submeter avaliação',
      congratulations: 'Parabéns!',
      notPassed: 'Avaliação não aprovada',
      successMessage: 'Concluiu a avaliação com sucesso.',
      failRetryMessage: 'Não atingiu a nota mínima. Pode tentar novamente.',
      noAttemptsMessage: 'Utilizou todas as tentativas disponíveis.',
      scoreDisplay: '{correct} de {total} corretas',
      tryAgain: 'Tentar novamente',
      alreadyComplete: 'Avaliação concluída',
      alreadyCompleteMessage: 'Já concluiu esta avaliação com sucesso.',
      lockedTitle: 'Avaliação bloqueada',
      lockedMessage: 'Utilizou todas as tentativas disponíveis e não atingiu a nota mínima.',
      bestScore: 'Melhor pontuação obtida',
    },
    quiz: {
      selectAll: 'Selecione todas as alternativas corretas',
      answerOptions: 'Opções de resposta',
      submit: 'Submeter',
      answerRecorded: 'Resposta registada',
      typeAnswer: 'Escreva a sua resposta...',
      answerInput: 'A sua resposta',
      correctAnswer: 'A resposta correta é: {answer}',
      attemptCount: 'Tentativa {current} de {max}',
    },
    media: {
      playNarration: 'Reproduzir narração',
      youtubeVideo: 'Vídeo do YouTube',
      vimeoVideo: 'Vídeo do Vimeo',
      googleDriveVideo: 'Vídeo do Google Drive',
      synthesiaVideo: 'Vídeo do Synthesia',
      loomVideo: 'Vídeo do Loom',
      embeddedContent: 'Conteúdo incorporado',
      showTranscript: 'Mostrar transcrição',
      hideTranscript: 'Ocultar transcrição',
    },
    tabs: {
      contentTabs: 'Separadores de conteúdo',
    },
    error: {
      loadingCourse: 'Erro ao carregar o conteúdo do curso.',
      noLesson: 'Nenhuma lição encontrada.',
      unsupportedBlock: 'Tipo de bloco não suportado: {type}',
    },
    loading: {
      text: 'A carregar...',
    },
    search: {
      placeholder: 'Pesquisar no curso...',
      clear: 'Limpar pesquisa',
      noResults: 'Sem resultados para "{query}"',
      resultsCount: '{count} resultados',
    },
    hotspot: {
      close: 'Fechar',
    },
    conclusion: {
      continue: 'Continuar',
      courseComplete: 'Curso concluído',
    },
    cover: {
      begin: 'Começar o curso',
      defaultMenuLabel: 'Bem-vindo',
      estimatedDuration: '{minutes} min',
      lesson: '{count} lição',
      lessons: '{count} lições'
    },
  },
  cy: {
    a11y: {
      carouselPrev: 'Cardiau blaenorol',
      carouselNext: 'Cardiau nesaf',
      flipCarouselPrev: 'Cerdyn blaenorol',
      flipCarouselNext: 'Cerdyn nesaf',
      goToSlide: 'Mynd i sleid {number}',
      flipCardHint: 'Troi\'r cerdyn. Pwyswch Enter neu cliciwch i droi.',
      flipHint: 'Cliciwch i droi',
      flipHintBack: 'Cliciwch i droi\'n ôl',
      dataTable: 'Tabl data',
      courseProgress: 'Cynnydd y cwrs',
      hotspot: 'Pwynt rhyngweithiol {number}',
    },
    nav: {
      previous: 'Blaenorol',
      next: 'Nesaf',
      progress: '{percent}% Wedi\'i Gwblhau',
      courseMenu: 'Dewislen y Cwrs',
      skipToContent: 'Neidio i\'r prif gynnwys',
      toggleNav: 'Toglo llywio',
      openMenu: 'Agor dewislen llywio',
      closeMenu: 'Cau dewislen llywio',
      previousLesson: 'Gwers flaenorol',
      nextLesson: 'Gwers nesaf',
      upNext: 'Nesaf',
      lessonProgress: 'Gwers {current} o {total}',
      courseComplete: 'Rydych wedi cyrraedd y diwedd',
      finalLesson: 'Gwers olaf',
      locked: 'Cwblhewch y gwersi blaenorol i ddatgloi',
      completeScroll: 'Cyrhaeddwch ddiwedd y wers hon i barhau.',
      completeQuestions: 'Atebwch gwestiynau\'r wers hon i barhau.',
      completeInteractions: 'Agorwch bob gweithgaredd ar y dudalen hon i barhau.',
      completePacing: 'Ar gael ymhen {time}',
      exitCourse: 'Gadael y cwrs',
      exitFallbackTitle: 'Cynnydd y cwrs wedi\'i gadw',
      exitFallbackMessage: 'Gallwch gau\'r tab hwn nawr.',
    },
    language: {
      select: 'Dewis iaith',
    },
    settings: {
      open: 'Gosodiadau',
      title: 'Gosodiadau',
      close: 'Cau',
      display: 'Arddangos',
      language: 'Iaith',
      highContrast: 'Cyferbyniad uchel',
      highContrastDesc: 'Cynyddu cyferbyniad er mwyn darllen yn haws',
      highContrastOn: 'Cyferbyniad uchel ymlaen',
      highContrastOff: 'Cyferbyniad uchel i ffwrdd',
      textSize: 'Maint y testun',
      textSizeIncrease: 'Cynyddu maint y testun',
      textSizeDecrease: 'Lleihau maint y testun',
      textSizeReset: 'Ailosod maint y testun',
      textSizeAnnounce: 'Maint y testun {percent}%',
    },
    assessment: {
      takeAssessment: 'Cymryd yr asesiad',
      completed: 'Wedi\'i gwblhau',
      locked: 'Wedi\'i gloi',
      title: 'Asesiad',
      description: 'Cwblhewch yr asesiad canlynol i orffen y cwrs hwn.',
      questions: 'Cwestiynau',
      passingScore: 'Sgôr pasio',
      attempts: 'Ymgeisiau',
      unlimitedAttempts: 'Ymgeisiau diderfyn',
      attemptCount: 'Ymgais {current} o {max}',
      start: 'Dechrau\'r asesiad',
      questionNumber: 'Cwestiwn {number}',
      answeredCount: '{answered} o {total} wedi\'u hateb',
      submit: 'Cyflwyno\'r asesiad',
      congratulations: 'Llongyfarchiadau!',
      notPassed: 'Heb basio\'r asesiad',
      successMessage: 'Rydych wedi cwblhau\'r asesiad yn llwyddiannus.',
      failRetryMessage: 'Ni wnaethoch gyrraedd y sgôr pasio. Gallwch roi cynnig arall arni.',
      noAttemptsMessage: 'Rydych wedi defnyddio\'ch holl ymgeisiau.',
      scoreDisplay: '{correct} o {total} yn gywir',
      tryAgain: 'Rhoi cynnig arall',
      alreadyComplete: 'Asesiad wedi\'i gwblhau',
      alreadyCompleteMessage: 'Rydych eisoes wedi cwblhau\'r asesiad hwn yn llwyddiannus.',
      lockedTitle: 'Asesiad wedi\'i gloi',
      lockedMessage: 'Rydych wedi defnyddio\'ch holl ymgeisiau a heb gyrraedd y sgôr pasio.',
      bestScore: 'Y sgôr gorau a gafwyd',
    },
    quiz: {
      selectAll: 'Dewiswch bob un sy\'n gywir',
      answerOptions: 'Opsiynau ateb',
      submit: 'Cyflwyno',
      answerRecorded: 'Ateb wedi\'i gofnodi',
      typeAnswer: 'Teipiwch eich ateb...',
      answerInput: 'Eich ateb',
      correctAnswer: 'Yr ateb cywir yw: {answer}',
      attemptCount: 'Ymgais {current} o {max}',
    },
    media: {
      playNarration: 'Chwarae\'r llefaru',
      youtubeVideo: 'Fideo YouTube',
      vimeoVideo: 'Fideo Vimeo',
      googleDriveVideo: 'Fideo Google Drive',
      synthesiaVideo: 'Fideo Synthesia',
      loomVideo: 'Fideo Loom',
      embeddedContent: 'Cynnwys wedi\'i fewnosod',
      showTranscript: 'Dangos trawsgrifiad',
      hideTranscript: 'Cuddio trawsgrifiad',
    },
    tabs: {
      contentTabs: 'Tabiau cynnwys',
    },
    error: {
      loadingCourse: 'Gwall wrth lwytho cynnwys y cwrs.',
      noLesson: 'Ni chanfuwyd unrhyw wers.',
      unsupportedBlock: 'Math o floc heb ei gefnogi: {type}',
    },
    loading: {
      text: 'Yn llwytho...',
    },
    search: {
      placeholder: 'Chwilio yn y cwrs...',
      clear: 'Clirio\'r chwiliad',
      noResults: 'Dim canlyniadau ar gyfer "{query}"',
      resultsCount: '{count} canlyniad',
    },
    hotspot: {
      close: 'Cau',
    },
    conclusion: {
      continue: 'Parhau',
      courseComplete: 'Cwrs wedi\'i gwblhau',
    },
    cover: {
      begin: "Dechrau'r cwrs",
      defaultMenuLabel: 'Croeso',
      estimatedDuration: '{minutes} mun',
      lesson: '{count} wers',
      lessons: '{count} gwers'
    },
  },
  sv: {
    a11y: {
      carouselPrev: 'Föregående kort',
      carouselNext: 'Nästa kort',
      flipCarouselPrev: 'Föregående kort',
      flipCarouselNext: 'Nästa kort',
      goToSlide: 'Gå till bild {number}',
      flipCardHint: 'Vänd kort. Tryck på Enter eller klicka för att vända.',
      flipHint: 'Klicka för att vända',
      flipHintBack: 'Klicka för att vända tillbaka',
      dataTable: 'Datatabell',
      courseProgress: 'Kursframsteg',
      hotspot: 'Interaktiv punkt {number}',
    },
    nav: {
      previous: 'Föregående',
      next: 'Nästa',
      progress: '{percent}% Slutfört',
      courseMenu: 'Kursmeny',
      skipToContent: 'Hoppa till huvudinnehåll',
      toggleNav: 'Växla navigering',
      openMenu: 'Öppna navigeringsmeny',
      closeMenu: 'Stäng navigeringsmeny',
      previousLesson: 'Föregående lektion',
      nextLesson: 'Nästa lektion',
      upNext: 'Nästa',
      lessonProgress: 'Lektion {current} av {total}',
      courseComplete: 'Du har nått slutet',
      finalLesson: 'Sista lektionen',
      locked: 'Slutför tidigare lektioner för att låsa upp',
      completeScroll: 'Nå slutet av den här lektionen för att fortsätta.',
      completeQuestions: 'Besvara lektionens frågor för att fortsätta.',
      completeInteractions: 'Öppna alla aktiviteter på den här sidan för att fortsätta.',
      completePacing: 'Tillgänglig om {time}',
      exitCourse: 'Lämna kursen',
      exitFallbackTitle: 'Kursframsteg sparat',
      exitFallbackMessage: 'Du kan nu stänga den här fliken.',
    },
    language: {
      select: 'Välj språk',
    },
    settings: {
      open: 'Inställningar',
      title: 'Inställningar',
      close: 'Stäng',
      display: 'Skärm',
      language: 'Språk',
      highContrast: 'Hög kontrast',
      highContrastDesc: 'Öka kontrasten för enklare läsning',
      highContrastOn: 'Hög kontrast på',
      highContrastOff: 'Hög kontrast av',
      textSize: 'Textstorlek',
      textSizeIncrease: 'Öka textstorleken',
      textSizeDecrease: 'Minska textstorleken',
      textSizeReset: 'Återställ textstorlek',
      textSizeAnnounce: 'Textstorlek {percent}%',
    },
    assessment: {
      takeAssessment: 'Genomför prov',
      completed: 'Slutfört',
      locked: 'Låst',
      title: 'Prov',
      description: 'Genomför följande prov för att avsluta denna kurs.',
      questions: 'Frågor',
      passingScore: 'Godkänt resultat',
      attempts: 'Försök',
      unlimitedAttempts: 'Obegränsat antal försök',
      attemptCount: 'Försök {current} av {max}',
      start: 'Starta prov',
      questionNumber: 'Fråga {number}',
      answeredCount: '{answered} av {total} besvarade',
      submit: 'Skicka in prov',
      congratulations: 'Grattis!',
      notPassed: 'Prov ej godkänt',
      successMessage: 'Du har genomfört provet.',
      failRetryMessage: 'Du uppnådde inte godkänt resultat. Du kan försöka igen.',
      noAttemptsMessage: 'Du har använt alla tillgängliga försök.',
      scoreDisplay: '{correct} av {total} korrekta',
      tryAgain: 'Försök igen',
      alreadyComplete: 'Prov slutfört',
      alreadyCompleteMessage: 'Du har redan genomfört detta prov.',
      lockedTitle: 'Prov låst',
      lockedMessage: 'Du har använt alla tillgängliga försök och uppnådde inte godkänt resultat.',
      bestScore: 'Bästa uppnådda resultat',
    },
    quiz: {
      selectAll: 'Välj alla som stämmer',
      answerOptions: 'Svarsalternativ',
      submit: 'Skicka in',
      answerRecorded: 'Svar registrerat',
      typeAnswer: 'Skriv ditt svar...',
      answerInput: 'Ditt svar',
      correctAnswer: 'Det rätta svaret är: {answer}',
      attemptCount: 'Försök {current} av {max}',
    },
    media: {
      playNarration: 'Spela upp berättarröst',
      youtubeVideo: 'YouTube-video',
      vimeoVideo: 'Vimeo-video',
      googleDriveVideo: 'Google Drive-video',
      synthesiaVideo: 'Synthesia-video',
      loomVideo: 'Loom-video',
      embeddedContent: 'Inbäddat innehåll',
      showTranscript: 'Visa transkription',
      hideTranscript: 'Dölj transkription',
    },
    tabs: {
      contentTabs: 'Innehållsflikar',
    },
    error: {
      loadingCourse: 'Fel vid laddning av kursinnehåll.',
      noLesson: 'Ingen lektion hittades.',
      unsupportedBlock: 'Blocktyp stöds inte: {type}',
    },
    loading: {
      text: 'Laddar...',
    },
    search: {
      placeholder: 'Sök i kurs...',
      clear: 'Rensa sökning',
      noResults: 'Inga resultat för "{query}"',
      resultsCount: '{count} resultat',
    },
    hotspot: {
      close: 'Stäng',
    },
    conclusion: {
      continue: 'Fortsätt',
      courseComplete: 'Kurs slutförd',
    },
    cover: {
      begin: 'Starta kursen',
      defaultMenuLabel: 'Välkommen',
      estimatedDuration: '{minutes} min',
      lesson: '{count} lektion',
      lessons: '{count} lektioner'
    },
  },
  zh: {
    a11y: {
      carouselPrev: '上一组卡片',
      carouselNext: '下一组卡片',
      flipCarouselPrev: '上一张卡片',
      flipCarouselNext: '下一张卡片',
      goToSlide: '转到第 {number} 张幻灯片',
      flipCardHint: '翻转卡片。按 Enter 键或点击以翻转。',
      flipHint: '点击翻转',
      flipHintBack: '点击翻回',
      dataTable: '数据表',
      courseProgress: '课程进度',
      hotspot: '热点 {number}',
    },
    nav: {
      previous: '上一步',
      next: '下一步',
      progress: '已完成 {percent}%',
      courseMenu: '课程菜单',
      skipToContent: '跳至主要内容',
      toggleNav: '切换导航',
      openMenu: '打开导航菜单',
      closeMenu: '关闭导航菜单',
      previousLesson: '上一课',
      nextLesson: '下一课',
      upNext: '接下来',
      lessonProgress: '第 {current} 课，共 {total} 课',
      courseComplete: '您已完成全部内容',
      finalLesson: '最后一课',
      locked: '完成前面的课程以解锁',
      completeScroll: '滚动到本课结尾以继续。',
      completeQuestions: '回答本课的问题以继续。',
      completeInteractions: '打开本页的所有互动内容以继续。',
      completePacing: '{time} 后可用',
      exitCourse: '退出课程',
      exitFallbackTitle: '课程进度已保存',
      exitFallbackMessage: '您现在可以关闭此标签页。',
    },
    language: {
      select: '选择语言',
    },
    settings: {
      open: '设置',
      title: '设置',
      close: '关闭',
      display: '显示',
      language: '语言',
      highContrast: '高对比度',
      highContrastDesc: '提高对比度，方便阅读',
      highContrastOn: '高对比度已开启',
      highContrastOff: '高对比度已关闭',
      textSize: '文字大小',
      textSizeIncrease: '增大文字',
      textSizeDecrease: '减小文字',
      textSizeReset: '重置文字大小',
      textSizeAnnounce: '文字大小 {percent}%',
    },
    assessment: {
      takeAssessment: '参加测评',
      completed: '已完成',
      locked: '已锁定',
      title: '测评',
      description: '完成以下测评以结束本课程。',
      questions: '题目',
      passingScore: '及格分数',
      attempts: '尝试次数',
      unlimitedAttempts: '不限次数',
      attemptCount: '第 {current} 次尝试，共 {max} 次',
      start: '开始测评',
      questionNumber: '第 {number} 题',
      answeredCount: '已回答 {answered} / {total}',
      submit: '提交测评',
      congratulations: '恭喜您！',
      notPassed: '测评未通过',
      successMessage: '您已成功完成测评。',
      failRetryMessage: '您未达到及格分数。可以再次尝试。',
      noAttemptsMessage: '您已用完所有可用尝试次数。',
      scoreDisplay: '答对 {correct} / {total}',
      tryAgain: '再试一次',
      alreadyComplete: '测评已完成',
      alreadyCompleteMessage: '您已成功完成此测评。',
      lockedTitle: '测评已锁定',
      lockedMessage: '您已用完所有尝试次数且未达到及格分数。',
      bestScore: '最佳成绩',
    },
    quiz: {
      selectAll: '请选择所有适用项',
      answerOptions: '答案选项',
      submit: '提交',
      answerRecorded: '答案已记录',
      typeAnswer: '请输入您的答案...',
      answerInput: '您的答案',
      correctAnswer: '正确答案是：{answer}',
      attemptCount: '第 {current} 次尝试，共 {max} 次',
    },
    media: {
      playNarration: '播放旁白',
      youtubeVideo: 'YouTube 视频',
      vimeoVideo: 'Vimeo 视频',
      googleDriveVideo: 'Google Drive 视频',
      synthesiaVideo: 'Synthesia 视频',
      loomVideo: 'Loom 视频',
      embeddedContent: '嵌入内容',
      showTranscript: '显示文字记录',
      hideTranscript: '隐藏文字记录',
    },
    tabs: {
      contentTabs: '内容标签',
    },
    error: {
      loadingCourse: '加载课程内容时出错。',
      noLesson: '未找到课程。',
      unsupportedBlock: '不支持的模块类型：{type}',
    },
    loading: {
      text: '加载中...',
    },
    search: {
      placeholder: '搜索课程...',
      clear: '清除搜索',
      noResults: '没有找到 "{query}" 的结果',
      resultsCount: '{count} 个结果',
    },
    hotspot: {
      close: '关闭',
    },
    conclusion: {
      continue: '继续',
      courseComplete: '课程已完成',
    },
    cover: {
      begin: '开始课程',
      defaultMenuLabel: '欢迎',
      estimatedDuration: '{minutes} 分钟',
      lesson: '{count} 课',
      lessons: '{count} 课'
    },
  },
  ja: {
    a11y: {
      carouselPrev: '前のカード',
      carouselNext: '次のカード',
      flipCarouselPrev: '前のカード',
      flipCarouselNext: '次のカード',
      goToSlide: 'スライド {number} へ移動',
      flipCardHint: 'カードを裏返す。Enter キーを押すかクリックして裏返します。',
      flipHint: 'クリックして裏返す',
      flipHintBack: 'クリックして戻す',
      dataTable: 'データテーブル',
      courseProgress: 'コースの進捗',
      hotspot: 'ホットスポット {number}',
    },
    nav: {
      previous: '前へ',
      next: '次へ',
      progress: '{percent}% 完了',
      courseMenu: 'コースメニュー',
      skipToContent: 'メインコンテンツへスキップ',
      toggleNav: 'ナビゲーションの切り替え',
      openMenu: 'ナビゲーションメニューを開く',
      closeMenu: 'ナビゲーションメニューを閉じる',
      previousLesson: '前のレッスン',
      nextLesson: '次のレッスン',
      upNext: '次は',
      lessonProgress: 'レッスン {current} / {total}',
      courseComplete: '最後まで完了しました',
      finalLesson: '最後のレッスン',
      locked: '前のレッスンを完了するとロック解除されます',
      completeScroll: 'このレッスンの最後までスクロールすると続行できます。',
      completeQuestions: 'このレッスンの設問に回答すると続行できます。',
      completeInteractions: 'このページのすべてのアクティビティを開くと続行できます。',
      completePacing: '{time} 後に利用可能',
      exitCourse: 'コースを終了',
      exitFallbackTitle: 'コースの進捗が保存されました',
      exitFallbackMessage: 'このタブを閉じても問題ありません。',
    },
    language: {
      select: '言語を選択',
    },
    settings: {
      open: '設定',
      title: '設定',
      close: '閉じる',
      display: '表示',
      language: '言語',
      highContrast: 'ハイコントラスト',
      highContrastDesc: 'コントラストを上げて読みやすくします',
      highContrastOn: 'ハイコントラスト オン',
      highContrastOff: 'ハイコントラスト オフ',
      textSize: '文字サイズ',
      textSizeIncrease: '文字を大きくする',
      textSizeDecrease: '文字を小さくする',
      textSizeReset: '文字サイズをリセット',
      textSizeAnnounce: '文字サイズ {percent}%',
    },
    assessment: {
      takeAssessment: '評価を受ける',
      completed: '完了',
      locked: 'ロック中',
      title: '評価',
      description: 'このコースを終了するには、次の評価を完了してください。',
      questions: '問題数',
      passingScore: '合格点',
      attempts: '受験回数',
      unlimitedAttempts: '回数制限なし',
      attemptCount: '{max} 回中 {current} 回目',
      start: '評価を開始',
      questionNumber: '問題 {number}',
      answeredCount: '{total} 問中 {answered} 問回答済み',
      submit: '評価を提出',
      congratulations: 'おめでとうございます！',
      notPassed: '評価不合格',
      successMessage: '評価を無事に完了しました。',
      failRetryMessage: '合格点に達しませんでした。再度受験できます。',
      noAttemptsMessage: '受験回数の上限に達しました。',
      scoreDisplay: '{total} 問中 {correct} 問正解',
      tryAgain: 'もう一度',
      alreadyComplete: '評価完了',
      alreadyCompleteMessage: 'この評価はすでに完了しています。',
      lockedTitle: '評価がロックされています',
      lockedMessage: '受験回数の上限に達しましたが、合格点に届きませんでした。',
      bestScore: 'ベストスコア',
    },
    quiz: {
      selectAll: '当てはまるものをすべて選択',
      answerOptions: '回答の選択肢',
      submit: '送信',
      answerRecorded: '回答を記録しました',
      typeAnswer: '回答を入力してください...',
      answerInput: 'あなたの回答',
      correctAnswer: '正解：{answer}',
      attemptCount: '{max} 回中 {current} 回目',
    },
    media: {
      playNarration: 'ナレーションを再生',
      youtubeVideo: 'YouTube 動画',
      vimeoVideo: 'Vimeo 動画',
      googleDriveVideo: 'Google ドライブ動画',
      synthesiaVideo: 'Synthesia 動画',
      loomVideo: 'Loom 動画',
      embeddedContent: '埋め込みコンテンツ',
      showTranscript: 'スクリプトを表示',
      hideTranscript: 'スクリプトを非表示',
    },
    tabs: {
      contentTabs: 'コンテンツタブ',
    },
    error: {
      loadingCourse: 'コースコンテンツの読み込み中にエラーが発生しました。',
      noLesson: 'レッスンが見つかりません。',
      unsupportedBlock: 'サポートされていないブロックタイプ：{type}',
    },
    loading: {
      text: '読み込み中...',
    },
    search: {
      placeholder: 'コースを検索...',
      clear: '検索をクリア',
      noResults: '「{query}」の結果はありません',
      resultsCount: '{count} 件の結果',
    },
    hotspot: {
      close: '閉じる',
    },
    conclusion: {
      continue: '続ける',
      courseComplete: 'コース完了',
    },
    cover: {
      begin: 'コースを開始',
      defaultMenuLabel: 'ようこそ',
      estimatedDuration: '{minutes} 分',
      lesson: '{count} レッスン',
      lessons: '{count} レッスン'
    },
  },
  hi: {
    a11y: {
      carouselPrev: 'पिछले कार्ड',
      carouselNext: 'अगले कार्ड',
      flipCarouselPrev: 'पिछला कार्ड',
      flipCarouselNext: 'अगला कार्ड',
      goToSlide: 'स्लाइड {number} पर जाएँ',
      flipCardHint: 'कार्ड पलटें। पलटने के लिए Enter दबाएँ या क्लिक करें।',
      flipHint: 'पलटने के लिए क्लिक करें',
      flipHintBack: 'वापस पलटने के लिए क्लिक करें',
      dataTable: 'डेटा तालिका',
      courseProgress: 'कोर्स की प्रगति',
      hotspot: 'हॉटस्पॉट {number}',
    },
    nav: {
      previous: 'पिछला',
      next: 'अगला',
      progress: '{percent}% पूर्ण',
      courseMenu: 'कोर्स मेनू',
      skipToContent: 'मुख्य सामग्री पर जाएँ',
      toggleNav: 'नेविगेशन टॉगल करें',
      openMenu: 'नेविगेशन मेनू खोलें',
      closeMenu: 'नेविगेशन मेनू बंद करें',
      previousLesson: 'पिछला पाठ',
      nextLesson: 'अगला पाठ',
      upNext: 'आगे',
      lessonProgress: 'पाठ {current} / {total}',
      courseComplete: 'आप अंत तक पहुँच गए हैं',
      finalLesson: 'अंतिम पाठ',
      locked: 'अनलॉक करने के लिए पिछले पाठ पूरे करें',
      completeScroll: 'जारी रखने के लिए इस पाठ के अंत तक पहुँचें।',
      completeQuestions: 'जारी रखने के लिए इस पाठ के प्रश्नों के उत्तर दें।',
      completeInteractions: 'जारी रखने के लिए इस पृष्ठ की सभी गतिविधियाँ खोलें।',
      completePacing: '{time} में उपलब्ध',
      exitCourse: 'कोर्स से बाहर निकलें',
      exitFallbackTitle: 'कोर्स की प्रगति सहेजी गई',
      exitFallbackMessage: 'अब आप यह टैब बंद कर सकते हैं।',
    },
    language: {
      select: 'भाषा चुनें',
    },
    settings: {
      open: 'सेटिंग',
      title: 'सेटिंग',
      close: 'बंद करें',
      display: 'डिसप्ले',
      language: 'भाषा',
      highContrast: 'ज़्यादा कंट्रास्ट',
      highContrastDesc: 'पढ़ने में आसानी के लिए कंट्रास्ट बढ़ाएँ',
      highContrastOn: 'ज़्यादा कंट्रास्ट चालू',
      highContrastOff: 'ज़्यादा कंट्रास्ट बंद',
      textSize: 'टेक्स्ट का साइज़',
      textSizeIncrease: 'टेक्स्ट का साइज़ बढ़ाएँ',
      textSizeDecrease: 'टेक्स्ट का साइज़ घटाएँ',
      textSizeReset: 'टेक्स्ट का साइज़ रीसेट करें',
      textSizeAnnounce: 'टेक्स्ट का साइज़ {percent}%',
    },
    assessment: {
      takeAssessment: 'मूल्यांकन दें',
      completed: 'पूर्ण',
      locked: 'लॉक',
      title: 'मूल्यांकन',
      description: 'इस कोर्स को पूरा करने के लिए निम्नलिखित मूल्यांकन पूरा करें।',
      questions: 'प्रश्न',
      passingScore: 'उत्तीर्ण अंक',
      attempts: 'प्रयास',
      unlimitedAttempts: 'असीमित प्रयास',
      attemptCount: 'प्रयास {current} / {max}',
      start: 'मूल्यांकन शुरू करें',
      questionNumber: 'प्रश्न {number}',
      answeredCount: '{total} में से {answered} उत्तर दिए गए',
      submit: 'मूल्यांकन जमा करें',
      congratulations: 'बधाई हो!',
      notPassed: 'मूल्यांकन उत्तीर्ण नहीं हुआ',
      successMessage: 'आपने मूल्यांकन सफलतापूर्वक पूरा कर लिया है।',
      failRetryMessage: 'आप उत्तीर्ण अंक तक नहीं पहुँचे। आप फिर से प्रयास कर सकते हैं।',
      noAttemptsMessage: 'आपने सभी उपलब्ध प्रयास उपयोग कर लिए हैं।',
      scoreDisplay: '{total} में से {correct} सही',
      tryAgain: 'फिर से प्रयास करें',
      alreadyComplete: 'मूल्यांकन पूर्ण',
      alreadyCompleteMessage: 'आपने यह मूल्यांकन पहले ही सफलतापूर्वक पूरा कर लिया है।',
      lockedTitle: 'मूल्यांकन लॉक है',
      lockedMessage: 'आपने सभी उपलब्ध प्रयास उपयोग कर लिए हैं और उत्तीर्ण अंक प्राप्त नहीं किए।',
      bestScore: 'सर्वश्रेष्ठ अंक',
    },
    quiz: {
      selectAll: 'जो भी लागू हों, सभी चुनें',
      answerOptions: 'उत्तर विकल्प',
      submit: 'जमा करें',
      answerRecorded: 'उत्तर दर्ज किया गया',
      typeAnswer: 'अपना उत्तर लिखें...',
      answerInput: 'आपका उत्तर',
      correctAnswer: 'सही उत्तर है: {answer}',
      attemptCount: 'प्रयास {current} / {max}',
    },
    media: {
      playNarration: 'विवरण चलाएँ',
      youtubeVideo: 'YouTube वीडियो',
      vimeoVideo: 'Vimeo वीडियो',
      googleDriveVideo: 'Google Drive वीडियो',
      synthesiaVideo: 'Synthesia वीडियो',
      loomVideo: 'Loom वीडियो',
      embeddedContent: 'एम्बेडेड सामग्री',
      showTranscript: 'ट्रांसक्रिप्ट दिखाएँ',
      hideTranscript: 'ट्रांसक्रिप्ट छिपाएँ',
    },
    tabs: {
      contentTabs: 'सामग्री टैब',
    },
    error: {
      loadingCourse: 'कोर्स सामग्री लोड करने में त्रुटि।',
      noLesson: 'कोई पाठ नहीं मिला।',
      unsupportedBlock: 'असमर्थित ब्लॉक प्रकार: {type}',
    },
    loading: {
      text: 'लोड हो रहा है...',
    },
    search: {
      placeholder: 'कोर्स खोजें...',
      clear: 'खोज साफ़ करें',
      noResults: '"{query}" के लिए कोई परिणाम नहीं',
      resultsCount: '{count} परिणाम',
    },
    hotspot: {
      close: 'बंद करें',
    },
    conclusion: {
      continue: 'जारी रखें',
      courseComplete: 'कोर्स पूर्ण',
    },
    cover: {
      begin: 'कोर्स शुरू करें',
      defaultMenuLabel: 'स्वागत है',
      estimatedDuration: '{minutes} मिनट',
      lesson: '{count} पाठ',
      lessons: '{count} पाठ'
    },
  },
}

/**
 * Get localized UI string with placeholder replacement
 * Falls back to English if translation not found
 */
function getUIString(lang, key, replacements = {}) {
  const keys = key.split('.')
  // Try requested language first
  let str = UI_STRINGS[lang]
  for (const k of keys) {
    str = str?.[k]
  }
  // Fallback to English
  if (!str) {
    str = UI_STRINGS.en
    for (const k of keys) {
      str = str?.[k]
    }
  }
  // Replace placeholders like {percent}
  if (str && typeof str === 'string') {
    for (const [k, v] of Object.entries(replacements)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
    }
  }
  return str || key
}

class SlatePlayer {
  // ============================================
  // CONSTRUCTOR & STATE
  // ============================================

  constructor() {
    this.course = null
    this.currentSectionIndex = 0
    this.currentLessonIndex = 0
    this.viewedLessons = new Set()
    this.completedChecks = new Set()
    this.lessonsReachedEnd = new Set()  // Lesson ids the learner has scrolled to the end of (completion-gate tracking)
    this.completedInteractions = new Set()  // Block ids fully explored when requireInteraction is on (persisted)
    this.lessonPacingElapsed = new Map()  // Lesson id -> accrued active seconds (Lesson Pacing; persisted)
    this.pacingTimerId = null             // setInterval handle for the 1s pacing tick
    this.interactionTargets = new Map()  // Current lesson's top-level interactive block ids -> required unit count
    this.interactionSeen = new Map()  // blockId -> Set of unit keys seen so far (per-lesson view state)
    this.knowledgeCheckAttempts = {}
    this.scorm = window.SCORM || null
    this.sidebarCollapsed = false
    this.mobileNavOpen = false
    this.navButtonsInitialized = false
    this.isVerticalLayout = false

    // Assessment state
    this.assessmentState = null
    this.isInAssessment = false
    this.assessmentQuestionOrder = []

    // Progress animation state
    this.lastDisplayedPercent = 0

    // xAPI / LRS state
    this.lrsConfig = null

    // Review mode state
    this.reviewMode = false
    this.reviewId = null
    this.highlightedTarget = null

    // SCORM interactions tracking
    this.interactionCount = 0

    // Language/translation state
    this.selectedLanguage = null  // null means source language
    this.availableLanguages = []  // populated from course.translations
    this.uiLang = 'en'  // UI strings language, synced with selectedLanguage

    // YouTube/Vimeo player tracking state
    this.ytPlayers = new Map()  // blockId -> YT.Player instance
    this.vimeoPlayers = new Map()  // blockId -> Vimeo.Player instance
    this.ytApiReady = false
    this.ytApiLoading = false
    this.ytPendingInits = []  // Queue of pending YouTube player initializations
    this.vimeoApiReady = false
    this.vimeoApiLoading = false
    this.vimeoPendingInits = []  // Queue of pending Vimeo player initializations

    // Share & Track state
    this.trackingConfig = null  // { linkId, requireEmail, requireConsent, supabaseUrl, supabaseKey }
    this.viewerConsent = null   // null = not asked, true = consented, false = declined
    this.viewerId = null        // Set after viewer registration
    this.viewerEmail = null
    this.viewerName = null

    // Search state
    this.searchIndex = []       // Array of searchable entries
    this.searchQuery = ''       // Current search query
    this.searchDebounceTimer = null
    this.isSearching = false    // Whether search results are being displayed

    // Collapsible course menu state (settings.collapsibleSections)
    this.expandedNavSections = new Set()  // Section keys the learner has open (runtime-only, not suspended)
    this.lastNavPositionKey = null        // Last section:lesson position renderNavigation saw (drives auto-expand on change)

    // Cleanup functions for event listeners (prevents memory leaks)
    this.cleanupFunctions = []

    // Conclusion page state
    this.showingConclusionPage = false
    this.conclusionViewed = false

    // Cover page state
    this.showingCoverPage = false
    this.coverViewed = false
    this._coverViewedThisSession = false

    // Debug mode — enable via window.__SLATE_DEBUG__ = true before player init
    this.debug = window.__SLATE_DEBUG__ || false
  }

  /**
   * Register a cleanup function to be called when navigating away from current lesson.
   * Use this to remove event listeners added during block rendering.
   */
  registerCleanup(fn) {
    this.cleanupFunctions.push(fn)
  }

  /**
   * Run all cleanup functions and clear the list.
   * Called before rendering new lesson content.
   */
  runCleanup() {
    // Run registered cleanup functions
    this.cleanupFunctions.forEach(fn => {
      try { fn() } catch (e) { /* ignore cleanup errors */ }
    })
    this.cleanupFunctions = []

    // Clean up YouTube players
    this.ytPlayers.forEach((player, blockId) => {
      try { player.destroy() } catch (e) { /* ignore */ }
    })
    this.ytPlayers.clear()

    // Clean up Vimeo players
    this.vimeoPlayers.forEach((player, blockId) => {
      try { player.destroy() } catch (e) { /* ignore */ }
    })
    this.vimeoPlayers.clear()
  }

  // ============================================
  // LOCALIZATION
  // ============================================

  /**
   * Get localized UI string with optional placeholder replacement
   * @param {string} key - Dot-notation key (e.g., 'nav.next')
   * @param {Object} replacements - Placeholder values (e.g., { percent: 75 })
   * @returns {string} - Localized string
   */
  t(key, replacements = {}) {
    return getUIString(this.uiLang, key, replacements)
  }

  // ============================================
  // GETTERS & COMPUTED PROPERTIES
  // ============================================

  get currentSection() {
    return this.course?.sections[this.currentSectionIndex]
  }

  get currentLesson() {
    return this.currentSection?.lessons[this.currentLessonIndex]
  }

  get allLessons() {
    return this.course?.sections.flatMap(s => s.lessons) || []
  }

  get totalLessons() {
    // Exclude assessment lessons - they use a separate completion pathway
    if (this.hasAssessment()) {
      return this.course?.sections
        .filter(s => !s.isAssessment)
        .flatMap(s => s.lessons)
        .filter(l => !this.isConclusionLesson(l) && !this.isCoverLesson(l)).length || 0
    }
    return this.allLessons.filter(l => !this.isConclusionLesson(l) && !this.isCoverLesson(l)).length
  }

  // Assessment helpers
  get assessmentConfig() {
    return this.course?.settings?.assessment
  }

  get assessmentSection() {
    return this.course?.sections.find(s => s.isAssessment)
  }

  get assessmentSectionIndex() {
    return this.course?.sections.findIndex(s => s.isAssessment) ?? -1
  }

  hasAssessment() {
    // Require all three conditions:
    // 1. Assessment enabled in settings
    // 2. Assessment section exists
    // 3. Assessment section has at least one question
    // This ensures courses with empty assessment sections complete based on lesson progress
    const config = this.course?.settings?.assessment
    if (!config?.enabled) return false
    if (!this.assessmentSection) return false
    // An empty assessment section (no questions) should be treated as "no assessment"
    return this.getAssessmentQuestions().length > 0
  }

  getAssessmentQuestions() {
    const section = this.assessmentSection
    if (!section) return []
    return section.lessons
      .filter(lesson => !this.isConclusionLesson(lesson) && !this.isCoverLesson(lesson))
      .flatMap(lesson =>
        lesson.blocks.filter(b => b.type === 'knowledge-check')
      )
  }

  /**
   * Find the lesson that contains a given assessment block (for translation lookup).
   */
  getAssessmentBlockLesson(blockId) {
    if (!this.assessmentSection) return null
    return this.assessmentSection.lessons
      .filter(lesson => !this.isConclusionLesson(lesson) && !this.isCoverLesson(lesson))
      .find(lesson => lesson.blocks.some(b => b.id === blockId)) || null
  }

  isCurrentSectionAssessment() {
    return this.currentSection?.isAssessment === true
  }

  canStartNewAttempt() {
    const config = this.assessmentConfig
    if (!config || config.maxAttempts === 0) return true
    const completed = this.assessmentState?.attempts?.filter(a => a.completedAt)?.length || 0
    return completed < config.maxAttempts
  }

  allContentLessonsViewed() {
    return this.course.sections
      .filter(s => !s.isAssessment)
      .flatMap(s => s.lessons)
      .filter(l => !this.isConclusionLesson(l) && !this.isCoverLesson(l))
      .every(l => this.viewedLessons.has(l.id))
  }

  isAssessmentLocked() {
    if (!this.hasAssessment()) return false
    // Lock assessment while a forward lesson gate is active, or until all content
    // lessons have been viewed under locked navigation.
    if (this.isLockedNavigation() && (this.isNextGated() || !this.allContentLessonsViewed())) return true
    return !this.canStartNewAttempt() && !this.hasPassedAssessment()
  }

  hasPassedAssessment() {
    return this.assessmentState?.attempts?.some(a => a.passed) || false
  }

  /**
   * Get the conclusion lesson (config-authoritative for visibility)
   */
  getConclusionLesson() {
    const config = this.assessmentConfig?.conclusionPage
    if (!config?.enabled || !config?.lessonId) return null

    // Global search across all sections
    for (const section of (this.course?.sections || [])) {
      const lesson = section.lessons.find(l => l.id === config.lessonId)
      if (lesson) return lesson
    }

    return null  // Config references non-existent lesson — silently disable
  }

  /**
   * Check if a lesson is a conclusion page (section-agnostic, used for ALL exclusions)
   */
  isConclusionLesson(lesson) {
    const configId = this.assessmentConfig?.conclusionPage?.lessonId
    return lesson.id === configId || lesson.isConclusionPage === true
  }

  getCoverLesson() {
    const config = this.course.settings?.coverPage
    if (!config?.enabled || !config?.lessonId) return null
    for (const section of this.course.sections) {
      const lesson = section.lessons.find(l => l.id === config.lessonId)
      if (lesson) return lesson
    }
    return null
  }

  isCoverLesson(lesson) {
    const configId = this.course.settings?.coverPage?.lessonId
    return lesson.id === configId || lesson.isCoverPage === true
  }

  // Resolves whether the cover should be showing, mutating this.showingCoverPage
  // when so. Called early in render() so renderNavigation can paint the Welcome
  // entry as active on first frame, and also again by renderCurrentLesson for
  // subsequent re-renders where the decision may flip.
  _resolveInitialCoverState() {
    const coverLesson = this.getCoverLesson()
    if (!coverLesson) {
      // No cover lesson (e.g. author just deleted it via hot-reload) — clear any
      // stale showing flag so render falls through to regular lesson rendering.
      this.showingCoverPage = false
      return
    }
    const atCoverLesson = this.currentLesson?.id === coverLesson.id
    const freshVisit = !this.coverViewed && this.course.settings?.coverPage?.enabled
    if (this.showingCoverPage || atCoverLesson || freshVisit) {
      this.showingCoverPage = true
    }
  }

  getCurrentAttemptNumber() {
    return (this.assessmentState?.attempts?.length || 0) + 1
  }

  // ============================================
  // LANGUAGE & TRANSLATION
  // ============================================

  /**
   * Get the source language of the course
   */
  get sourceLanguage() {
    return this.course?.meta?.language || 'en'
  }

  /**
   * Check if we're viewing a translation (not the source language)
   */
  get isViewingTranslation() {
    return this.selectedLanguage && this.selectedLanguage !== this.sourceLanguage
  }

  /**
   * Initialize language from browser preference or saved selection
   */
  initLanguage() {
    // Build list of available languages
    this.availableLanguages = [this.sourceLanguage]
    if (this.course?.translations) {
      this.availableLanguages.push(...Object.keys(this.course.translations))
    }

    // Try to load saved preference (skip in SCORM mode)
    if (!this.scorm) {
      const saved = safeStorage.getItem('slate-language')
      if (saved && this.availableLanguages.includes(saved)) {
        this.selectedLanguage = saved
        this.uiLang = UI_STRINGS[saved] ? saved : 'en'
        return
      }
    }

    // Auto-detect from browser if we have translations
    if (this.availableLanguages.length > 1) {
      const browserLang = navigator.language?.split('-')[0] // e.g., 'en-US' -> 'en'
      if (browserLang && this.availableLanguages.includes(browserLang)) {
        this.selectedLanguage = browserLang
      } else {
        this.selectedLanguage = this.sourceLanguage
      }
    } else {
      this.selectedLanguage = this.sourceLanguage
    }

    // Sync UI language with selected language
    this.uiLang = UI_STRINGS[this.selectedLanguage] ? this.selectedLanguage : 'en'
  }

  /**
   * Reflect the active content language on <html lang> so assistive tech uses
   * the correct pronunciation rules. Called after initial language detection
   * and on every runtime language switch. (WCAG 3.1.1 / 3.1.2)
   */
  applyDocumentLanguage() {
    const lang = this.selectedLanguage || this.sourceLanguage || 'en'
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('lang', lang)
    }
  }

  /**
   * Change the display language
   */
  setLanguage(langCode) {
    if (!this.availableLanguages.includes(langCode)) return

    this.selectedLanguage = langCode

    // Sync UI language (use if we have strings for it, otherwise English)
    this.uiLang = UI_STRINGS[langCode] ? langCode : 'en'

    // Reflect the new language on <html lang> for assistive tech
    this.applyDocumentLanguage()

    // Save preference (skip in SCORM mode)
    if (!this.scorm) {
      safeStorage.setItem('slate-language', langCode)
    }

    // Re-render to apply translations. Flag this as a relocalization so the
    // renderCurrentLesson() navigation-close doesn't close the settings pane —
    // a language switch from inside the pane must keep it open (relocalizes in place).
    this._relocalizing = true
    try {
      this.updateUIStrings()
      this.renderNavigation()
      this.renderCurrentLesson()
      this.updateCourseTitle()
      this.updateLanguageSelector()

      // Rebuild search index for new language
      if (this.course?.settings?.enableSearch !== false) {
        this.buildSearchIndex()
      }
    } finally {
      this._relocalizing = false
    }
  }

  /**
   * Update fixed UI elements with localized strings
   */
  updateUIStrings() {
    // Navigation buttons
    const prevBtn = document.getElementById('btn-prev')
    const nextBtn = document.getElementById('btn-next')
    if (prevBtn) prevBtn.textContent = this.t('nav.previous')
    if (nextBtn) nextBtn.textContent = this.t('nav.next')

    // Progress text
    const progressText = document.getElementById('progress-text')
    if (progressText) {
      progressText.textContent = this.t('nav.progress', { percent: this.lastDisplayedPercent || 0 })
    }

    // Skip link
    const skipLink = document.querySelector('.skip-link')
    if (skipLink) skipLink.textContent = this.t('nav.skipToContent')

    // Language selector label
    const langLabel = document.querySelector('.language-label')
    if (langLabel) langLabel.textContent = this.t('language.select')

    // Relocalize the settings pane labels in place (language can switch from inside it)
    this._localizeSettingsPane()

    // Vertical layout nav: re-render since cards contain lesson titles that may be translated
    if (this.isVerticalLayout) {
      const container = document.getElementById('player-content')
      if (container) {
        // Remove old vertical nav elements
        container.querySelector('.vertical-nav-prev')?.remove()
        container.querySelector('.vertical-nav-next-card')?.remove()
        container.querySelector('.vertical-end-card')?.remove()
        this.renderVerticalInlineNav(container)
      }
    }
  }

  /**
   * Get translated course title
   */
  getTranslatedCourseTitle() {
    if (!this.isViewingTranslation) {
      return this.course?.meta?.title || 'Course'
    }
    return this.course?.translations?.[this.selectedLanguage]?.meta?.title
      || this.course?.meta?.title || 'Course'
  }

  /**
   * Get translated section title
   */
  getTranslatedSectionTitle(section) {
    if (!this.isViewingTranslation) {
      return section.title
    }
    return this.course?.translations?.[this.selectedLanguage]?.sections?.[section.id]?.title
      || section.title
  }

  /**
   * Get translated lesson title
   */
  getTranslatedLessonTitle(lesson) {
    if (!this.isViewingTranslation) {
      return lesson.title
    }
    return lesson.translations?.[this.selectedLanguage]?.title
      || lesson.title
  }

  /**
   * Get narration for a block based on selected language
   * Returns translated narration if available, otherwise null (no fallback)
   */
  getBlockNarration(block, lesson) {
    if (!this.isViewingTranslation) {
      // Source language - use block.narration directly
      return block.narration || null
    }

    // Viewing translation - check for translated narration
    const translatedBlock = lesson?.translations?.[this.selectedLanguage]?.blocks
      ?.find(tb => tb.blockId === block.id)

    if (translatedBlock?.narration?.audioUrl) {
      return translatedBlock.narration
    }

    // No translated narration - return null (no fallback per requirements)
    return null
  }

  /**
   * Get translated block content
   * Returns merged content with translated fields overwriting source
   */
  getTranslatedBlockContent(block, lesson) {
    if (!this.isViewingTranslation || !lesson?.translations?.[this.selectedLanguage]?.blocks) {
      return block.content
    }

    const translatedBlock = lesson.translations[this.selectedLanguage].blocks
      .find(tb => tb.blockId === block.id)

    if (!translatedBlock?.content) {
      return block.content
    }

    // Deep merge for nested content types
    if (block.type === 'accordion' && block.content.items && translatedBlock.content.items) {
      return {
        ...block.content,
        items: block.content.items.map((item, idx) => {
          const translatedItem = translatedBlock.content.items[idx]
          if (!translatedItem) return item
          return {
            ...item,
            title: translatedItem.title ?? item.title,
            items: item.items.map((nested, nIdx) => {
              const translatedNested = translatedItem.items?.[nIdx]
              if (!translatedNested) return nested
              return {
                ...nested,
                content: translatedNested.content ?? nested.content,
                alt: translatedNested.alt ?? nested.alt,
                caption: translatedNested.caption ?? nested.caption,
                transcript: translatedNested.transcript ?? nested.transcript
              }
            })
          }
        })
      }
    }

    if (block.type === 'tabs' && block.content.items && translatedBlock.content.items) {
      return {
        ...block.content,
        items: block.content.items.map((tab, idx) => {
          const translatedTab = translatedBlock.content.items[idx]
          if (!translatedTab) return tab
          return {
            ...tab,
            label: translatedTab.label ?? tab.label,
            items: tab.items.map((item, iIdx) => {
              const translatedItem = translatedTab.items?.[iIdx]
              if (!translatedItem) return item
              return {
                ...item,
                content: translatedItem.content ?? item.content,
                alt: translatedItem.alt ?? item.alt,
                caption: translatedItem.caption ?? item.caption,
                transcript: translatedItem.transcript ?? item.transcript
              }
            })
          }
        })
      }
    }

    if (block.type === 'knowledge-check') {
      const merged = {
        ...block.content,
        ...translatedBlock.content,
      }
      // Merge options for MC/MS
      if (block.content.options && translatedBlock.content.options) {
        merged.options = block.content.options.map((opt, idx) => {
          const translatedOpt = translatedBlock.content.options[idx]
          if (!translatedOpt) return opt
          return { ...opt, ...translatedOpt }
        })
      }
      // Merge acceptedAnswers for FIB
      if (translatedBlock.content.acceptedAnswers) {
        merged.acceptedAnswers = translatedBlock.content.acceptedAnswers
      } else if (block.content.acceptedAnswers) {
        merged.acceptedAnswers = block.content.acceptedAnswers
      }
      return merged
    }

    if (block.type === 'layout' && block.content.cells && translatedBlock.content.cells) {
      // Per-type merge for nested blocks so card/flip-card structural fields
      // (image src, item type, etc.) survive — a shallow spread on a nested
      // card would replace source items with a translations-only array and
      // lose the image URLs. Mirrors the deep-merge treatment at the top
      // level for each supported nested type.
      const mergeCardSide = (sourceSide, translatedSide) => {
        if (!translatedSide) return sourceSide
        return {
          ...sourceSide,
          title: translatedSide.title ?? sourceSide.title,
          subtitle: translatedSide.subtitle ?? sourceSide.subtitle,
          imageAlt: translatedSide.imageAlt ?? sourceSide.imageAlt,
          items: sourceSide.items?.map((item, idx) => {
            const tItem = translatedSide.items?.[idx]
            if (!tItem) return item
            return {
              ...item,
              content: tItem.content ?? item.content,
              alt: tItem.alt ?? item.alt,
              caption: tItem.caption ?? item.caption,
              transcript: tItem.transcript ?? item.transcript
            }
          }) ?? sourceSide.items
        }
      }
      return {
        ...block.content,
        cells: block.content.cells.map((cell, cIdx) => {
          const translatedCell = translatedBlock.content.cells[cIdx]
          if (!translatedCell?.blocks) return cell
          return {
            ...cell,
            blocks: cell.blocks.map((cellBlock, bIdx) => {
              const translatedCellBlock = translatedCell.blocks[bIdx]
              if (!translatedCellBlock?.content) return cellBlock
              const tContent = translatedCellBlock.content

              // Per-type merge for nested blocks whose translated shape is
              // sparse enough that a shallow spread would lose structural
              // data (card/flip-card items with image URLs, etc.).
              if (cellBlock.type === 'card') {
                return { ...cellBlock, content: mergeCardSide(cellBlock.content, tContent) }
              }
              if (cellBlock.type === 'flip-card') {
                return {
                  ...cellBlock,
                  content: {
                    ...cellBlock.content,
                    front: mergeCardSide(cellBlock.content.front, tContent.front),
                    back: mergeCardSide(cellBlock.content.back, tContent.back)
                  }
                }
              }
              // text / image / video / audio / button / iframe / divider:
              // shallow spread is fine — their translated content is a
              // simple field-level overlay with no nested arrays.
              return {
                ...cellBlock,
                content: { ...cellBlock.content, ...tContent }
              }
            })
          }
        })
      }
    }

    // Deep merge for card block (title, subtitle, imageAlt, items)
    if (block.type === 'card') {
      return {
        ...block.content,
        title: translatedBlock.content.title ?? block.content.title,
        subtitle: translatedBlock.content.subtitle ?? block.content.subtitle,
        imageAlt: translatedBlock.content.imageAlt ?? block.content.imageAlt,
        items: block.content.items?.map((item, idx) => {
          const translatedItem = translatedBlock.content.items?.[idx]
          if (!translatedItem) return item
          return {
            ...item,
            content: translatedItem.content ?? item.content,
            alt: translatedItem.alt ?? item.alt,
            caption: translatedItem.caption ?? item.caption,
            transcript: translatedItem.transcript ?? item.transcript
          }
        }) ?? block.content.items
      }
    }

    // Deep merge for flip-card block (front and back, each with title, subtitle, imageAlt, items)
    if (block.type === 'flip-card') {
      const mergedContent = { ...block.content }

      // Merge front side
      if (block.content.front && translatedBlock.content.front) {
        mergedContent.front = {
          ...block.content.front,
          title: translatedBlock.content.front.title ?? block.content.front.title,
          subtitle: translatedBlock.content.front.subtitle ?? block.content.front.subtitle,
          imageAlt: translatedBlock.content.front.imageAlt ?? block.content.front.imageAlt,
          items: block.content.front.items?.map((item, idx) => {
            const translatedItem = translatedBlock.content.front.items?.[idx]
            if (!translatedItem) return item
            return {
              ...item,
              content: translatedItem.content ?? item.content,
              alt: translatedItem.alt ?? item.alt,
              caption: translatedItem.caption ?? item.caption,
              transcript: translatedItem.transcript ?? item.transcript
            }
          }) ?? block.content.front.items
        }
      }

      // Merge back side
      if (block.content.back && translatedBlock.content.back) {
        mergedContent.back = {
          ...block.content.back,
          title: translatedBlock.content.back.title ?? block.content.back.title,
          subtitle: translatedBlock.content.back.subtitle ?? block.content.back.subtitle,
          imageAlt: translatedBlock.content.back.imageAlt ?? block.content.back.imageAlt,
          items: block.content.back.items?.map((item, idx) => {
            const translatedItem = translatedBlock.content.back.items?.[idx]
            if (!translatedItem) return item
            return {
              ...item,
              content: translatedItem.content ?? item.content,
              alt: translatedItem.alt ?? item.alt,
              caption: translatedItem.caption ?? item.caption,
              transcript: translatedItem.transcript ?? item.transcript
            }
          }) ?? block.content.back.items
        }
      }

      return mergedContent
    }

    // Deep merge for flip-card-carousel block (cards with front/back, each with title, subtitle, imageAlt, items)
    if (block.type === 'flip-card-carousel' && block.content.cards && translatedBlock.content.cards) {
      const mergeSide = (side, translatedSide) => {
        if (!side || !translatedSide) return side
        return {
          ...side,
          title: translatedSide.title ?? side.title,
          subtitle: translatedSide.subtitle ?? side.subtitle,
          imageAlt: translatedSide.imageAlt ?? side.imageAlt,
          items: side.items?.map((item, idx) => {
            const tItem = translatedSide.items?.[idx]
            if (!tItem) return item
            return {
              ...item,
              content: tItem.content ?? item.content,
              alt: tItem.alt ?? item.alt,
              caption: tItem.caption ?? item.caption,
              transcript: tItem.transcript ?? item.transcript
            }
          }) ?? side.items
        }
      }
      return {
        ...block.content,
        cards: block.content.cards.map((card, cIdx) => {
          const translatedCard = translatedBlock.content.cards[cIdx]
          if (!translatedCard) return card
          return {
            ...card,
            front: mergeSide(card.front, translatedCard.front),
            back: mergeSide(card.back, translatedCard.back)
          }
        })
      }
    }

    // Deep merge for image block (alt, caption, and hotspots). Translated hotspots
    // must keep their source x/y positions; merging by hotspot id (falling back to
    // index) preserves positional data even if the translation was stored with
    // only text fields.
    //
    // Caption is learner-visible text: once a translation record exists for this
    // block, the learner's language must show only the translator's caption
    // (including blank), never a source-language fallback. A French learner
    // seeing an English caption is confusing and makes the translation look
    // broken; blank is always safer than wrong-language prose.
    if (block.type === 'image') {
      const merged = { ...block.content, ...translatedBlock.content }
      merged.caption = translatedBlock.content.caption ?? ''
      if (block.content.hotspots && translatedBlock.content.hotspots) {
        const translatedById = new Map()
        translatedBlock.content.hotspots.forEach((th, i) => {
          if (th?.id) translatedById.set(th.id, th)
          translatedById.set(`__idx_${i}`, th)
        })
        merged.hotspots = block.content.hotspots.map((hs, i) => {
          const t = (hs?.id && translatedById.get(hs.id)) || translatedById.get(`__idx_${i}`)
          if (!t) return hs
          return {
            ...hs,
            label: t.label ?? hs.label,
            description: t.description ?? hs.description
          }
        })
      }
      return merged
    }

    // Deep merge for card-carousel block (cards array, each with title, subtitle, imageAlt, items)
    if (block.type === 'card-carousel' && block.content.cards && translatedBlock.content.cards) {
      return {
        ...block.content,
        cards: block.content.cards.map((card, cIdx) => {
          const translatedCard = translatedBlock.content.cards[cIdx]
          if (!translatedCard) return card
          return {
            ...card,
            title: translatedCard.title ?? card.title,
            subtitle: translatedCard.subtitle ?? card.subtitle,
            imageAlt: translatedCard.imageAlt ?? card.imageAlt,
            items: card.items?.map((item, iIdx) => {
              const translatedItem = translatedCard.items?.[iIdx]
              if (!translatedItem) return item
              return {
                ...item,
                content: translatedItem.content ?? item.content,
                alt: translatedItem.alt ?? item.alt,
                caption: translatedItem.caption ?? item.caption,
                transcript: translatedItem.transcript ?? item.transcript
              }
            }) ?? card.items
          }
        })
      }
    }

    // Video / audio: caption is learner-visible text. Same principle as image —
    // once a translation record exists, show only the translator's caption
    // (including blank), never a source-language fallback.
    if (block.type === 'video' || block.type === 'audio') {
      const merged = { ...block.content, ...translatedBlock.content }
      merged.caption = translatedBlock.content.caption ?? ''
      return merged
    }

    // Simple merge for other block types
    return { ...block.content, ...translatedBlock.content }
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  async init() {
    // For SCORM thin packages, wait for scorm-init to be received
    // This ensures suspend_data is cached before we try to restore it
    // Only do this for thin packages (detected by SCORM_THIN_READY flag)
    if (this.scorm && window.SCORM_THIN_READY) {
      let scormInitWaitCount = 0
      while (!window.__SCORM_INIT_COMPLETE__ && scormInitWaitCount < 100) {
        await new Promise(resolve => setTimeout(resolve, 50))
        scormInitWaitCount++
      }
      if (window.__SCORM_INIT_COMPLETE__) {
        console.log('SCORM Thin init complete, proceeding with load')
      }
    }

    if (this.scorm) {
      this.scorm.LMSInitialize('')
      this.loadProgress()

      // Only set status to incomplete on FIRST open (no suspend_data yet)
      // This prevents SCORM Cloud from auto-marking as complete
      // If resuming, preserve the existing status set by wrapper or previous session
      const data = this.scorm.LMSGetValue('cmi.suspend_data')
      if (!data) {
        // First open: set to incomplete until user completes
        this.scorm.LMSSetValue('cmi.core.lesson_status', 'incomplete')
        this.scorm.LMSCommit('')
      }
    }

    console.log('[INIT] hasAssessment=' + this.hasAssessment() + ', hasPassedAssessment=' + this.hasPassedAssessment())

    // Load sidebar preference (skip in SCORM mode - shared localStorage causes issues)
    if (!this.scorm) {
      const savedCollapsed = safeStorage.getItem('slate-nav-collapsed')
      if (savedCollapsed === 'true') {
        this.sidebarCollapsed = true
      }
    }

    // Load course data
    try {
      // Check for embedded course data first (used in previews)
      if (window.__SLATE_COURSE_DATA__) {
        this.course = window.__SLATE_COURSE_DATA__
      } else {
        // Fetch from course.json (SCORM package / export)
        const response = await fetch('course.json')
        this.course = await response.json()
      }

      // Initialize language before rendering
      this.initLanguage()
      this.applyDocumentLanguage()

      // Initialize tracking if config is present
      if (window.__SLATE_TRACKING_CONFIG__) {
        this.trackingConfig = window.__SLATE_TRACKING_CONFIG__
        await this.initTracking()
      }

      this.render()

      // Set initial score of 0 for assessment courses (so LMS shows 0% not blank)
      if (this.scorm && this.hasAssessment() && !this.hasPassedAssessment()) {
        // Check if we already have a score from a previous attempt
        const lastAttempt = this.assessmentState?.attempts?.[this.assessmentState.attempts.length - 1]
        const initialScore = lastAttempt?.score ?? 0
        this.scorm.LMSSetValue('cmi.core.score.min', '0')
        this.scorm.LMSSetValue('cmi.core.score.max', '100')
        this.scorm.LMSSetValue('cmi.core.score.raw', initialScore.toString())
        this.scorm.LMSCommit('')
      }

      // Initialize hot-reload if enabled
      this.initHotReload()

      // Initialize review mode listener (for builder integration)
      this.initReviewMode()
    } catch (error) {
      console.error('Failed to load course:', error)
      document.getElementById('player-content').innerHTML =
        `<p>${escapeHtml(this.t('error.loadingCourse'))}</p>`
    }
  }

  // ============================================
  // HOT RELOAD
  // ============================================

  /**
   * Initialize hot-reload via postMessage (for sandboxed iframes)
   * The parent page bridges BroadcastChannel messages to the iframe via postMessage
   */
  initHotReload() {
    if (!window.__SLATE_HOT_RELOAD__ || !this.course?.id) return

    // Listen for postMessage from parent (works in sandboxed iframes)
    // When sandboxed without allow-same-origin, self.origin is 'null' (opaque) —
    // skip origin check since the sandbox itself is the security boundary.
    window.addEventListener('message', (event) => {
      if (self.origin !== 'null' && event.origin !== self.origin) return
      if (event.data?.type === 'COURSE_UPDATE' && event.data?.course) {
        this.handleCourseUpdate(event.data.course)
      }
    })

    if (this.debug) console.log('[HotReload] Listening for updates via postMessage')
  }

  /**
   * Handle course update from postMessage
   */
  handleCourseUpdate(newCourse) {
    // 1. Save current navigation state
    const navState = {
      sectionIndex: this.currentSectionIndex,
      lessonIndex: this.currentLessonIndex,
      scrollTop: document.getElementById('player-content')?.scrollTop || 0
    }

    // 2. Show loading indicator
    this.showUpdateIndicator()

    // 3. Update course data
    this.course = newCourse

    // 4. Validate and restore navigation (handle deleted sections/lessons)
    const maxSectionIndex = Math.max(0, this.course.sections.length - 1)
    this.currentSectionIndex = Math.min(navState.sectionIndex, maxSectionIndex)

    const section = this.course.sections[this.currentSectionIndex]
    const maxLessonIndex = Math.max(0, (section?.lessons?.length || 1) - 1)
    this.currentLessonIndex = Math.min(navState.lessonIndex, maxLessonIndex)

    // 5. Tell renderCurrentLesson() to restore scroll instead of resetting to top
    this._pendingScrollRestore = navState.scrollTop

    // 6. Re-render
    this.render()

    // 7. Hide indicator after render settles (renderCurrentLesson has 150ms delay)
    setTimeout(() => this.hideUpdateIndicator(), 350)
  }

  /**
   * Show loading indicator during hot-reload update
   */
  showUpdateIndicator() {
    if (document.getElementById('slate-update-indicator')) return

    const indicator = document.createElement('div')
    indicator.id = 'slate-update-indicator'
    indicator.className = 'slate-update-indicator'
    document.body.appendChild(indicator)
  }

  /**
   * Hide loading indicator after hot-reload update
   */
  hideUpdateIndicator() {
    const indicator = document.getElementById('slate-update-indicator')
    if (indicator) {
      indicator.remove()
    }
  }

  // ============================================
  // REVIEW MODE
  // ============================================

  /**
   * Initialize review mode listener for builder integration
   * Listens for postMessage commands from parent frame
   */
  initReviewMode() {
    window.addEventListener('message', (event) => {
      // When sandboxed without allow-same-origin, self.origin is 'null' (opaque) —
      // skip origin check since the sandbox itself is the security boundary.
      if (self.origin !== 'null' && event.origin !== self.origin) return
      const { type } = event.data || {}

      switch (type) {
        case 'ENABLE_REVIEW_MODE':
          this.enableReviewMode(event.data.reviewId)
          break
        case 'DISABLE_REVIEW_MODE':
          this.disableReviewMode()
          break
        case 'HIGHLIGHT_TARGET':
          this.highlightTarget(event.data.target)
          break
        case 'CLEAR_HIGHLIGHTS':
          this.clearHighlights()
          break
        case 'NAVIGATE_TO':
          this.goToLesson(event.data.sectionIndex, event.data.lessonIndex)
          break
      }
    })
  }

  /**
   * Enable review mode - adds visual indicators and click handlers
   */
  enableReviewMode(reviewId) {
    if (this.reviewMode) return

    this.reviewMode = true
    this.reviewId = reviewId
    document.body.classList.add('review-mode')

    // Setup block click handlers
    this.setupReviewClickHandlers()

    // Setup text selection handler
    this.setupReviewSelectionHandler()

    // Notify parent that review mode is ready
    this.postToParent({ type: 'REVIEW_MODE_READY' })

    if (this.debug) console.log('[ReviewMode] Enabled for review:', reviewId)
  }

  /**
   * Disable review mode - removes visual indicators and handlers
   */
  disableReviewMode() {
    if (!this.reviewMode) return

    this.reviewMode = false
    this.reviewId = null
    document.body.classList.remove('review-mode')

    // Clear any highlights
    this.clearHighlights()

    // Remove event listeners (they're added with { once: false } so we need cleanup)
    // The handlers check this.reviewMode so they become no-ops

    if (this.debug) console.log('[ReviewMode] Disabled')
  }

  /**
   * Setup click handlers on blocks for issue creation
   */
  setupReviewClickHandlers() {
    const container = document.getElementById('player-content')
    if (!container) return

    container.addEventListener('click', (event) => {
      if (!this.reviewMode) return

      // Find closest block
      const block = event.target.closest('.slate-block')
      if (!block) return

      const blockId = block.dataset.blockId
      const blockType = block.dataset.blockType
      if (!blockId) return

      // Get current section/lesson context
      const section = this.currentSection
      const lesson = this.currentLesson

      // Send block click to parent
      this.postToParent({
        type: 'BLOCK_CLICKED',
        blockId: blockId,
        blockType: blockType,
        lessonId: lesson?.id,
        sectionId: section?.id
      })
    })
  }

  /**
   * Setup text selection handler for precise issue targeting
   */
  setupReviewSelectionHandler() {
    document.addEventListener('mouseup', () => {
      if (!this.reviewMode) return

      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.toString().trim() === '') {
        // Selection cleared
        this.postToParent({ type: 'SELECTION_CLEARED' })
        return
      }

      // Find the containing block
      const range = selection.getRangeAt(0)
      const block = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer.closest('.slate-block')
        : range.commonAncestorContainer.parentElement?.closest('.slate-block')

      if (!block) return

      const blockId = block.dataset.blockId
      if (!blockId) return

      // Get selection bounds for popover positioning
      const rect = range.getBoundingClientRect()

      // Build target with selection details
      const target = {
        type: 'selection',
        sectionId: this.currentSection?.id,
        lessonId: this.currentLesson?.id,
        blockId: blockId,
        selection: {
          text: {
            blockType: this.getBlockType(block),
            startOffset: this.getTextOffset(block, range.startContainer, range.startOffset),
            endOffset: this.getTextOffset(block, range.endContainer, range.endOffset),
            selectedText: selection.toString()
          }
        }
      }

      this.postToParent({
        type: 'SELECTION_MADE',
        target: target,
        rect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          bottom: rect.bottom,
          right: rect.right
        }
      })
    })
  }

  /**
   * Get block type from element
   */
  getBlockType(element) {
    const classes = element.className.split(' ')
    const typeClass = classes.find(c => c.startsWith('block-'))
    return typeClass ? typeClass.replace('block-', '') : 'unknown'
  }

  /**
   * Calculate text offset within a block for selection serialization
   */
  getTextOffset(blockElement, node, offset) {
    // Simple offset calculation - count characters from start of block
    const walker = document.createTreeWalker(
      blockElement,
      NodeFilter.SHOW_TEXT,
      null,
      false
    )

    let totalOffset = 0
    let currentNode = walker.nextNode()

    while (currentNode) {
      if (currentNode === node) {
        return totalOffset + offset
      }
      totalOffset += currentNode.textContent.length
      currentNode = walker.nextNode()
    }

    return totalOffset + offset
  }

  /**
   * Highlight a specific target (block or selection)
   */
  highlightTarget(target) {
    // Clear existing highlights first
    this.clearHighlights()

    if (!target) return

    // Navigate to the correct lesson if needed
    if (target.sectionId && target.lessonId) {
      const sectionIndex = this.course.sections.findIndex(s => s.id === target.sectionId)
      if (sectionIndex >= 0) {
        const section = this.course.sections[sectionIndex]
        const lessonIndex = section.lessons.findIndex(l => l.id === target.lessonId)
        if (lessonIndex >= 0 && (sectionIndex !== this.currentSectionIndex || lessonIndex !== this.currentLessonIndex)) {
          this.goToLesson(sectionIndex, lessonIndex)
          // Wait for render then highlight
          setTimeout(() => this.applyHighlight(target), 200)
          return
        }
      }
    }

    this.applyHighlight(target)
  }

  /**
   * Apply highlight styles to target element
   */
  applyHighlight(target) {
    if (target.blockId) {
      const block = document.querySelector(`[data-block-id="${target.blockId}"]`)
      if (block) {
        block.classList.add('review-highlight')
        this.highlightedTarget = target

        // Scroll block into view
        block.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }

  }

  /**
   * Clear all review highlights
   */
  clearHighlights() {
    document.querySelectorAll('.review-highlight').forEach(el => {
      el.classList.remove('review-highlight')
    })
    this.highlightedTarget = null
  }

  /**
   * Send message to parent frame (builder)
   */
  postToParent(message) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, '*')
    }
  }

  // ============================================
  // SHARE & TRACK
  // ============================================

  /**
   * Initialize tracking - show email modal if required, register viewer
   */
  async initTracking() {
    if (!this.trackingConfig) return

    // Check for returning viewer in localStorage
    const savedViewer = this.getSavedViewer()
    if (savedViewer) {
      this.viewerEmail = savedViewer.email
      this.viewerName = savedViewer.name
      await this.registerViewer()
      return
    }

    // Show email capture modal if required
    if (this.trackingConfig.requireEmail) {
      await this.showEmailModal()
    } else {
      // Anonymous tracking - register without email
      await this.registerViewer()
    }
  }

  /**
   * Get saved viewer from localStorage
   */
  getSavedViewer() {
    if (!this.trackingConfig) return null
    try {
      // Check for pre-seeded viewer data from parent frame (sandbox bridge)
      if (window.__SLATE_SAVED_VIEWER__) {
        return window.__SLATE_SAVED_VIEWER__
      }
      const key = `slate_viewer_${this.trackingConfig.linkId}`
      const saved = safeStorage.getItem(key)
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  }

  /**
   * Save viewer to localStorage
   */
  saveViewer(email, name) {
    if (!this.trackingConfig) return
    try {
      const key = `slate_viewer_${this.trackingConfig.linkId}`
      const data = JSON.stringify({ email, name })
      safeStorage.setItem(key, data)
      // Post to parent frame so it can persist in real localStorage (sandbox bridge)
      this.postToParent({ type: 'VIEWER_SAVED', key, data })
    } catch {
      // Storage not available, continue anyway
    }
  }

  /**
   * Show email capture modal
   * Returns a promise that resolves when the user submits their info
   */
  showEmailModal() {
    return new Promise((resolve) => {
      const requireConsent = this.trackingConfig?.requireConsent

      // Create modal overlay
      const overlay = document.createElement('div')
      overlay.className = 'slate-email-overlay'
      overlay.innerHTML = `
        <div class="slate-email-modal" role="dialog" aria-modal="true" aria-labelledby="slate-modal-title">
          <h2 id="slate-modal-title">Welcome</h2>
          <p>Please enter your details to access this course.</p>
          <form id="slate-email-form">
            <div class="slate-form-field">
              <label for="slate-viewer-name">Name</label>
              <input type="text" id="slate-viewer-name" name="name" placeholder="Your name" autocomplete="name">
            </div>
            <div class="slate-form-field">
              <label for="slate-viewer-email">Email <span class="required">*</span></label>
              <input type="email" id="slate-viewer-email" name="email" required placeholder="your@email.com" autocomplete="email">
            </div>
            ${requireConsent ? `
            <div class="slate-form-field slate-consent-field">
              <label class="slate-checkbox-label">
                <input type="checkbox" id="slate-viewer-consent" name="consent">
                <span>I agree to receive email communications about this course</span>
              </label>
            </div>
            ` : ''}
            <div class="slate-form-error" id="slate-email-error" role="alert"></div>
            <button type="submit" class="slate-submit-btn">Continue to Course</button>
          </form>
        </div>
      `
      document.body.appendChild(overlay)

      // Focus the email input for keyboard users
      const emailInput = overlay.querySelector('#slate-viewer-email')
      if (emailInput) emailInput.focus()

      // Handle form submission
      const form = overlay.querySelector('#slate-email-form')
      const errorEl = overlay.querySelector('#slate-email-error')

      form.addEventListener('submit', async (e) => {
        e.preventDefault()
        const name = form.querySelector('#slate-viewer-name').value.trim()
        const email = form.querySelector('#slate-viewer-email').value.trim()
        const consentCheckbox = form.querySelector('#slate-viewer-consent')
        const consent = requireConsent ? consentCheckbox?.checked : null

        if (!this.validateEmail(email)) {
          errorEl.textContent = 'Please enter a valid email address'
          return
        }

        this.viewerEmail = email
        this.viewerName = name
        this.viewerConsent = consent
        this.saveViewer(email, name)
        overlay.remove()

        await this.registerViewer()
        resolve()
      })
    })
  }

  /**
   * Validate email format
   */
  validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }

  /**
   * Register viewer with backend
   */
  async registerViewer() {
    if (!this.trackingConfig) return

    try {
      const totalLessons = this.countTotalLessons()

      const response = await fetch(
        `${this.trackingConfig.supabaseUrl}/rest/v1/rpc/register_tracked_viewer`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.trackingConfig.supabaseKey,
            'Authorization': `Bearer ${this.trackingConfig.supabaseKey}`
          },
          body: JSON.stringify({
            p_link_id: this.trackingConfig.linkId,
            p_email: this.viewerEmail || null,
            p_name: this.viewerName || null,
            p_total_lessons: totalLessons,
            p_has_assessment: this.hasAssessment(),
            p_email_consent: this.viewerConsent
          })
        }
      )

      if (response.ok) {
        const result = await response.json()
        this.viewerId = result.id

        // Restore previous progress if any
        if (result.lessons_viewed && result.lessons_viewed.length > 0) {
          result.lessons_viewed.forEach(lessonId => {
            this.viewedLessons.add(lessonId)
          })
        }
      } else {
        const errorText = await response.text()
        console.warn('Failed to register viewer (HTTP error):', { status: response.status, statusText: response.statusText, body: errorText })
      }
    } catch (error) {
      console.warn('Failed to register viewer (fetch error):', error)
      // Non-blocking - continue with course access
    }
  }

  /**
   * Count total lessons in the course
   */
  countTotalLessons() {
    if (!this.course?.sections) return 0
    return this.course.sections.reduce((total, section) => {
      // Don't count assessment section lessons in progress
      if (section.isAssessment) return total
      const contentLessons = section.lessons.filter(l => !this.isConclusionLesson(l) && !this.isCoverLesson(l))
      return total + contentLessons.length
    }, 0)
  }

  /**
   * A "single screen" course has exactly one place to be: no assessment, no
   * cover page, and at most one content lesson. There is nothing to navigate
   * to, so when the course menu is turned off the sequential nav controls
   * (footer / inline up-next) can be safely hidden along with the sidebar.
   * Anything with a second destination (more lessons, a cover page, or an
   * assessment) is NOT single-screen, so it keeps its sequential controls and
   * a learner can never be stranded with the menu hidden.
   */
  isSingleScreenCourse() {
    if (this.hasAssessment()) return false
    if (this.course?.settings?.coverPage?.enabled) return false
    return this.totalLessons <= 1
  }

  /**
   * Track lesson view
   */
  async trackLessonView(lessonId) {
    if (!this.viewerId || !this.trackingConfig) return

    try {
      await fetch(
        `${this.trackingConfig.supabaseUrl}/rest/v1/rpc/update_tracked_progress`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.trackingConfig.supabaseKey,
            'Authorization': `Bearer ${this.trackingConfig.supabaseKey}`
          },
          body: JSON.stringify({
            p_view_id: this.viewerId,
            p_lesson_id: lessonId
          })
        }
      )
    } catch (error) {
      console.warn('Failed to track lesson view:', error)
      // Non-blocking - don't interrupt user experience
    }
  }

  /**
   * Track assessment passed (for Share & Track)
   */
  async trackAssessmentPassed() {
    if (!this.viewerId || !this.trackingConfig) return

    try {
      await fetch(
        `${this.trackingConfig.supabaseUrl}/rest/v1/rpc/mark_tracked_assessment_passed`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.trackingConfig.supabaseKey,
            'Authorization': `Bearer ${this.trackingConfig.supabaseKey}`
          },
          body: JSON.stringify({
            p_view_id: this.viewerId
          })
        }
      )
    } catch (error) {
      console.warn('Failed to track assessment completion:', error)
      // Non-blocking - don't interrupt user experience
    }
  }

  // ============================================
  // RENDERING & LAYOUT
  // ============================================

  render() {
    // Add skip link for accessibility
    this.addSkipLink()

    // Set title (using translated title if applicable)
    this.updateCourseTitle()

    // Apply theme settings
    this.applyThemeSettings()

    // Apply saved learner accessibility prefs (high contrast / text size).
    // After theme so the high-contrast token overrides win; before content render to avoid flash.
    this.applyAccessibilityPrefs()

    // Detect vertical navigation layout mode
    this.isVerticalLayout = this.course.settings.navigationLayout === 'vertical'
    if (this.isVerticalLayout) {
      document.getElementById('slate-player')?.classList.add('layout-vertical')
      this.renderVerticalProgressBar()
    }

    // Course menu visibility. settings.showNavigation === false hides the
    // sidebar menu (and its toggles) in every layout. When the course is a
    // single screen (no assessment, no cover, at most one lesson) there is
    // nowhere to navigate, so the sequential controls are dropped too (the
    // footer in classic layout, the inline up-next in vertical) for a clean,
    // chrome-free render — what an LMS that supplies its own per-lesson menu
    // wants. Multi-screen courses keep those sequential controls as a safety
    // net so a learner can never be stranded with the menu hidden.
    this.menuHidden = this.course.settings.showNavigation === false
    this.navChromeHidden = this.menuHidden && this.isSingleScreenCourse()
    const playerRoot = document.getElementById('slate-player')
    if (playerRoot) {
      playerRoot.classList.toggle('nav-menu-hidden', this.menuHidden)
      playerRoot.classList.toggle('nav-chrome-hidden', this.navChromeHidden)
    }

    // Initialize LRS config for xAPI (from runtime injection)
    this.initLrsConfig()

    // Setup sidebar (before navigation)
    this.setupSidebar()

    // Setup accessibility / settings button (the language selector now lives inside it)
    this.setupSettingsButton()

    // Resolve cover state BEFORE rendering navigation so the sidebar can mark
    // the Welcome entry active on first paint. (renderCurrentLesson also resolves
    // this, but runs after renderNavigation here.)
    this._resolveInitialCoverState()

    // Render navigation
    if (this.course.settings.showNavigation) {
      this.renderNavigation()
    }

    // Build search index if enabled
    if (this.isSearchEnabled()) {
      this.buildSearchIndex()
    }

    // Render current lesson
    this.renderCurrentLesson()

    // Setup navigation buttons
    this.setupNavButtons()

    // Update UI strings based on language
    this.updateUIStrings()

    // Setup scroll indicator
    this.setupScrollIndicator()

    // Setup the lesson completion gate (no-op unless requireLessonCompletion is on)
    this.setupCompletionGate()

    // Set initial progress (skip animation on first render if resuming)
    if (this.viewedLessons.size > 0) {
      this.lastDisplayedPercent = Math.round((this.viewedLessons.size / this.totalLessons) * 100)
    }
    this.updateProgress()

    // Track initial lesson view for Share & Track (skip assessment sections)
    const lesson = this.currentLesson
    if (lesson?.id && this.trackingConfig && !this.isCurrentSectionAssessment()) {
      this.trackLessonView(lesson.id)
    }
  }

  /**
   * Update the course title in the header
   */
  updateCourseTitle() {
    const title = this.getTranslatedCourseTitle()
    const titleEl = document.getElementById('course-title')
    const logoEl = document.getElementById('course-logo')
    const logoUrl = this.course.settings?.logoUrl

    if (logoUrl && logoEl) {
      // Show logo, keep title accessible to screen readers
      if (titleEl) {
        titleEl.textContent = title
        titleEl.classList.add('sr-only')
        titleEl.style.display = ''
      }
      logoEl.src = logoUrl
      logoEl.alt = title
      logoEl.style.display = 'block'
    } else {
      // Show title, hide logo
      if (titleEl) {
        titleEl.classList.remove('sr-only')
        titleEl.style.display = 'block'
        titleEl.textContent = title
      }
      if (logoEl) logoEl.style.display = 'none'
    }

    document.title = title
  }

  // The five discrete text-size levels (1 = default). Shared by the stepper,
  // clamping, and the saved-pref reader.
  get textScaleLevels() {
    return [0.9, 1, 1.1, 1.25, 1.4]
  }

  /**
   * Apply saved learner accessibility preferences (high contrast + text size).
   * Called from render() right after applyThemeSettings() so the high-contrast
   * token overrides win over the inline theme variables, and before content is
   * rendered so there is no flash of un-adjusted UI.
   */
  applyAccessibilityPrefs() {
    const root = document.documentElement

    // High contrast — a class toggle; the `html.slate-hc { ... !important }`
    // block in styles.css beats the inline theme vars set on :root.
    const hc = safeStorage.getItem('slate-a11y-contrast') === 'on'
    root.classList.toggle('slate-hc', hc)
    // Custom CSS is injected during applyThemeSettings (before this runs), so
    // suppress it now if HC is active.
    this._syncCustomCssForContrast()

    // Text size — a root-font-size multiplier consumed by styles.css. Set
    // unconditionally (incl. '1') so a stale enlarged value can't survive a
    // re-render that resolves back to the default in the same document.
    const saved = parseFloat(safeStorage.getItem('slate-a11y-text-scale'))
    this.textScale = this.textScaleLevels.includes(saved) ? saved : 1
    root.style.setProperty('--slate-text-scale', String(this.textScale))
  }

  /**
   * Setup the accessibility / settings button in the header. Unlike the old
   * language selector this renders for EVERY course (accessibility is universal);
   * the Language section inside the pane is what's gated on having translations.
   */
  setupSettingsButton() {
    const headerRight = document.getElementById('header-right')
    if (!headerRight || headerRight.querySelector('.settings-button')) return

    const hasLanguages = this.availableLanguages.length > 1

    // Trigger button (gear icon; currentColor so it tracks the text token incl. HC)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'settings-button'
    btn.setAttribute('aria-haspopup', 'dialog')
    btn.setAttribute('aria-expanded', 'false')
    btn.setAttribute('aria-controls', 'slate-settings-pane')
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`

    // Pane (dialog). Labels are filled by _localizeSettingsPane so language
    // switches relocalize it in place.
    const pane = document.createElement('div')
    pane.className = 'settings-pane'
    pane.id = 'slate-settings-pane'
    pane.setAttribute('role', 'dialog')
    pane.setAttribute('aria-modal', 'true')
    pane.setAttribute('aria-labelledby', 'slate-settings-title')
    pane.hidden = true

    const languageSection = hasLanguages ? `
      <section class="settings-section">
        <div class="settings-row settings-row-language">
          <span class="settings-row-label" id="slate-language-label" data-settings-label="language"></span>
          <select id="slate-language-select" class="language-select" aria-labelledby="slate-language-label"></select>
        </div>
      </section>` : ''

    pane.innerHTML = `
      <div class="settings-pane-header">
        <h2 class="settings-pane-title" id="slate-settings-title"></h2>
        <button class="settings-pane-close" type="button">&times;</button>
      </div>
      <section class="settings-section">
        <h3 class="settings-section-title" data-settings-title="display"></h3>
        <div class="settings-row">
          <span class="settings-row-label" id="slate-hc-label">
            <span class="settings-row-name" data-settings-label="highContrast"></span>
            <span class="settings-row-desc" data-settings-label="highContrastDesc"></span>
          </span>
          <button id="slate-hc-toggle" class="settings-switch" type="button" role="switch" aria-checked="false" aria-labelledby="slate-hc-label"><span class="settings-switch-thumb" aria-hidden="true"></span></button>
        </div>
        <div class="settings-row settings-row-textsize">
          <span class="settings-row-label" id="slate-textsize-label" data-settings-label="textSize"></span>
          <div class="settings-textsize" role="group" aria-labelledby="slate-textsize-label">
            <button class="settings-textsize-btn" type="button" data-step="-1"></button>
            <span class="settings-textsize-value" aria-hidden="true">100%</span>
            <button class="settings-textsize-btn" type="button" data-step="1"></button>
            <button class="settings-textsize-reset" type="button"></button>
          </div>
        </div>
      </section>
      ${languageSection}
      <div class="sr-only" aria-live="polite" id="slate-settings-status"></div>
    `

    headerRight.appendChild(btn)
    headerRight.appendChild(pane)
    this._settingsButton = btn
    this._settingsPane = pane

    // Language options (reuse existing helpers + setLanguage)
    if (hasLanguages) {
      const select = pane.querySelector('#slate-language-select')
      this.availableLanguages.forEach(lang => {
        const option = document.createElement('option')
        option.value = lang
        option.textContent = this.getLanguageDisplayName(lang)
        if (lang === this.selectedLanguage) option.selected = true
        select.appendChild(option)
      })
      select.addEventListener('change', (e) => this.setLanguage(e.target.value))
    }

    // Open / close
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (pane.hidden) this.openSettings()
      else this.closeSettings(true)
    })
    pane.querySelector('.settings-pane-close').addEventListener('click', () => this.closeSettings(true))

    // High contrast toggle
    const hcToggle = pane.querySelector('#slate-hc-toggle')
    hcToggle.addEventListener('click', () => {
      this.toggleHighContrast(hcToggle.getAttribute('aria-checked') !== 'true')
    })

    // Text size stepper
    pane.querySelectorAll('.settings-textsize-btn').forEach(b => {
      b.addEventListener('click', () => this.stepTextScale(parseInt(b.dataset.step, 10)))
    })
    pane.querySelector('.settings-textsize-reset').addEventListener('click', () => this.setTextScale(1))

    // Escape closes; Tab is trapped within the pane while open
    pane.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.closeSettings(true)
      } else if (e.key === 'Tab') {
        this._trapFocus(e, pane)
      }
    })

    this._localizeSettingsPane()
    this._syncSettingsControls()
    // Note: the pane is closed on lesson navigation by closeSettings() at the
    // top of renderCurrentLesson — not via registerCleanup, which is one-shot
    // (consumed by the first renderCurrentLesson) and so wouldn't fire later.
  }

  /**
   * (Re)apply localized labels to the settings pane. Called on build and from
   * updateUIStrings() so switching language relabels the pane in place.
   */
  _localizeSettingsPane() {
    const pane = this._settingsPane
    const btn = this._settingsButton
    if (!pane || !btn) return

    btn.setAttribute('aria-label', this.t('settings.open'))
    pane.querySelector('#slate-settings-title').textContent = this.t('settings.title')
    pane.querySelector('.settings-pane-close').setAttribute('aria-label', this.t('settings.close'))

    pane.querySelectorAll('[data-settings-title]').forEach(el => {
      el.textContent = this.t('settings.' + el.dataset.settingsTitle)
    })
    pane.querySelectorAll('[data-settings-label]').forEach(el => {
      el.textContent = this.t('settings.' + el.dataset.settingsLabel)
    })

    const dec = pane.querySelector('.settings-textsize-btn[data-step="-1"]')
    const inc = pane.querySelector('.settings-textsize-btn[data-step="1"]')
    dec.textContent = 'A−' // A−
    dec.setAttribute('aria-label', this.t('settings.textSizeDecrease'))
    inc.textContent = 'A+'
    inc.setAttribute('aria-label', this.t('settings.textSizeIncrease'))
    pane.querySelector('.settings-textsize-reset').textContent = this.t('settings.textSizeReset')
    // The language select is labelled by the visible "Language" row label
    // (aria-labelledby), matching the high-contrast and text-size rows — no
    // separate aria-label, which would otherwise override that visible name.
  }

  /** Reflect current saved state (contrast + text size) in the pane controls. */
  _syncSettingsControls() {
    const pane = this._settingsPane
    if (!pane) return
    const hc = document.documentElement.classList.contains('slate-hc')
    pane.querySelector('#slate-hc-toggle')?.setAttribute('aria-checked', hc ? 'true' : 'false')

    const scale = this.textScale ?? 1
    const levels = this.textScaleLevels
    const idx = levels.indexOf(scale)
    const valueEl = pane.querySelector('.settings-textsize-value')
    if (valueEl) valueEl.textContent = Math.round(scale * 100) + '%'
    const dec = pane.querySelector('.settings-textsize-btn[data-step="-1"]')
    const inc = pane.querySelector('.settings-textsize-btn[data-step="1"]')
    // aria-disabled (not the `disabled` property) keeps the button focusable, so
    // reaching a bound while it's keyboard-focused doesn't blur to <body> and
    // break the focus trap. stepTextScale no-ops at the bounds.
    if (dec) dec.setAttribute('aria-disabled', String(idx <= 0))
    if (inc) inc.setAttribute('aria-disabled', String(idx >= levels.length - 1))
  }

  openSettings() {
    const pane = this._settingsPane
    const btn = this._settingsButton
    if (!pane || !pane.hidden) return
    pane.hidden = false
    btn.setAttribute('aria-expanded', 'true')

    if (window.innerWidth < 640) {
      pane.classList.add('settings-pane-mobile')
      // Move the pane out to <body> so it isn't trapped in the header's stacking
      // context (the sticky header has a z-index, which clips the fixed sheet
      // behind the body-level backdrop). Also gives true viewport-relative fixed
      // positioning. closeSettings() moves it back for desktop anchoring.
      document.body.appendChild(pane)
      const backdrop = document.createElement('div')
      backdrop.className = 'settings-backdrop'
      backdrop.addEventListener('click', () => this.closeSettings(true))
      document.body.appendChild(backdrop)
      document.body.style.overflow = 'hidden'
      this._settingsBackdrop = backdrop
      // Animate in: the sheet/backdrop mount in their closed state (off-screen,
      // transparent); flip to .is-open next frame so the CSS transition runs.
      requestAnimationFrame(() => {
        pane.classList.add('is-open')
        backdrop.classList.add('is-open')
      })
    }

    pane.querySelector('.settings-pane-close')?.focus({ preventScroll: true })

    // Outside-click closes (deferred so the opening click doesn't immediately close it)
    this._settingsOutsideClick = (e) => {
      if (!pane.contains(e.target) && !btn.contains(e.target)) this.closeSettings()
    }
    setTimeout(() => document.addEventListener('click', this._settingsOutsideClick), 0)

    // Close on a breakpoint cross so an open pane can't get stuck in the wrong
    // layout (mobile sheet ↔ desktop popover). Compares the category, not raw
    // width, so mobile URL-bar show/hide resizes don't close it mid-use.
    this._settingsOpenedMobile = window.innerWidth < 640
    this._settingsResize = () => {
      if ((window.innerWidth < 640) !== this._settingsOpenedMobile) this.closeSettings(true)
    }
    window.addEventListener('resize', this._settingsResize)
  }

  closeSettings(restoreFocus = false) {
    const pane = this._settingsPane
    const btn = this._settingsButton
    if (!pane || pane.hidden || this._settingsClosing) return
    const wasMobile = pane.classList.contains('settings-pane-mobile')
    btn.setAttribute('aria-expanded', 'false')

    // Tear down interaction listeners immediately (don't wait for the exit anim).
    if (this._settingsOutsideClick) {
      document.removeEventListener('click', this._settingsOutsideClick)
      this._settingsOutsideClick = null
    }
    if (this._settingsResize) {
      window.removeEventListener('resize', this._settingsResize)
      this._settingsResize = null
    }

    const finalize = () => {
      pane.hidden = true
      pane.classList.remove('settings-pane-mobile', 'is-open')
      // Return the pane to the header so the desktop popover re-anchors correctly.
      if (wasMobile) btn.parentElement.appendChild(pane)
      if (this._settingsBackdrop) {
        this._settingsBackdrop.remove()
        this._settingsBackdrop = null
        document.body.style.overflow = ''
      }
      this._settingsClosing = false
      if (restoreFocus) btn.focus()
    }

    if (wasMobile) {
      // Play the entrance in reverse (slide down + fade), then finalize. Reduced
      // motion collapses the transition to ~0 via the global media query, so
      // transitionend still fires; the timeout is a safety net either way.
      this._settingsClosing = true
      pane.classList.remove('is-open')
      this._settingsBackdrop?.classList.remove('is-open')
      let done = false
      const onEnd = (e) => {
        if (done) return
        if (e && (e.target !== pane || e.propertyName !== 'transform')) return
        done = true
        pane.removeEventListener('transitionend', onEnd)
        finalize()
      }
      pane.addEventListener('transitionend', onEnd)
      setTimeout(() => onEnd(), 400)
    } else {
      finalize()
    }
  }

  /** Keep Tab focus inside the open pane. */
  _trapFocus(e, container) {
    const focusable = Array.from(container.querySelectorAll(
      'button:not([disabled]), [href], select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null || el === document.activeElement)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  /** Toggle high contrast and persist it. */
  toggleHighContrast(on) {
    document.documentElement.classList.toggle('slate-hc', !!on)
    this._syncCustomCssForContrast()
    this._settingsPane?.querySelector('#slate-hc-toggle')?.setAttribute('aria-checked', on ? 'true' : 'false')
    safeStorage.setItem('slate-a11y-contrast', on ? 'on' : 'off')
    this._announceSettings(this.t(on ? 'settings.highContrastOn' : 'settings.highContrastOff'))
  }

  /** Step the text size by ±1 level (clamped; no-op at the bounds). */
  stepTextScale(step) {
    const levels = this.textScaleLevels
    let idx = levels.indexOf(this.textScale ?? 1)
    if (idx === -1) idx = 1
    const next = levels[Math.max(0, Math.min(levels.length - 1, idx + step))]
    if (next !== this.textScale) this.setTextScale(next)
  }

  /** Set the text size to a discrete level and persist it. */
  setTextScale(scale) {
    if (!this.textScaleLevels.includes(scale)) scale = 1
    this.textScale = scale
    document.documentElement.style.setProperty('--slate-text-scale', String(scale))
    safeStorage.setItem('slate-a11y-text-scale', String(scale))
    this._syncSettingsControls()
    this._announceSettings(this.t('settings.textSizeAnnounce', { percent: Math.round(scale * 100) }))
  }

  _announceSettings(msg) {
    const status = this._settingsPane?.querySelector('#slate-settings-status')
    if (status) status.textContent = msg
  }

  /**
   * Update the language selector to reflect current selection
   */
  updateLanguageSelector() {
    const select = document.querySelector('.language-select')
    if (select) {
      select.value = this.selectedLanguage
    }
  }

  /**
   * Get display name for a language code (compact format: EN, FR-CA, etc.)
   */
  getLanguageDisplayName(langCode) {
    return langCode.toUpperCase()
  }

  addSkipLink() {
    if (document.querySelector('.skip-link')) return

    const skipLink = document.createElement('a')
    skipLink.href = '#player-content'
    skipLink.className = 'skip-link'
    skipLink.textContent = this.t('nav.skipToContent')
    document.body.prepend(skipLink)
  }

  // Darken a hex color by a percentage (for auto-deriving hover color)
  darkenColor(hex, percent = 10) {
    const num = parseInt(hex.replace('#', ''), 16)
    const r = Math.max(0, (num >> 16) - Math.round(255 * percent / 100))
    const g = Math.max(0, ((num >> 8) & 0x00FF) - Math.round(255 * percent / 100))
    const b = Math.max(0, (num & 0x0000FF) - Math.round(255 * percent / 100))
    return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`
  }

  // Lighten a hex color by mixing with white (for light backgrounds)
  lightenColor(hex, percent = 90) {
    const num = parseInt(hex.replace('#', ''), 16)
    const r = Math.min(255, (num >> 16) + Math.round((255 - (num >> 16)) * percent / 100))
    const g = Math.min(255, ((num >> 8) & 0x00FF) + Math.round((255 - ((num >> 8) & 0x00FF)) * percent / 100))
    const b = Math.min(255, (num & 0x0000FF) + Math.round((255 - (num & 0x0000FF)) * percent / 100))
    return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`
  }

  // WCAG relative luminance for a #RRGGBB hex string.
  relativeLuminance(hex) {
    const clean = (hex || '').replace('#', '')
    if (clean.length !== 6) return 0
    const num = parseInt(clean, 16)
    if (Number.isNaN(num)) return 0
    const channels = [(num >> 16) & 0xFF, (num >> 8) & 0xFF, num & 0xFF]
    const linear = channels.map(c => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  }

  // Pick a contrasting foreground (#fff or near-black) for a given background hex.
  // Threshold ~0.5 keeps white on mid-tones (blue, orange, green-500) and flips
  // to near-black on pastels (pink, yellow, mint). Prevents unreadable white-on-pastel CTAs.
  deriveForegroundColor(hex) {
    return this.relativeLuminance(hex) > 0.5 ? '#0a0a0a' : '#ffffff'
  }

  applyThemeSettings() {
    const settings = this.course.settings
    const root = document.documentElement

    // Primary color (also used as accent color for backwards compatibility)
    const primaryColor = settings.primaryColor || settings.accentColor || '#3B82F6'
    root.style.setProperty('--accent-color', primaryColor)
    root.style.setProperty('--primary-color', primaryColor)

    // Foreground for surfaces painted with --accent-color / --primary-color.
    // Auto-derived from luminance so light pastel brand colors don't render
    // white-on-pastel CTAs. Authors can override via settings.primaryForegroundColor.
    const primaryForeground = settings.primaryForegroundColor || this.deriveForegroundColor(primaryColor)
    root.style.setProperty('--accent-foreground', primaryForeground)
    root.style.setProperty('--primary-foreground', primaryForeground)

    // Light accent color for backgrounds (e.g., document icon backgrounds)
    const accentLight = this.lightenColor(primaryColor, 90)
    root.style.setProperty('--accent-color-light', accentLight)

    // Hover color (auto-derive from primary if not set)
    const hoverColor = settings.hoverColor || this.darkenColor(primaryColor, 10)
    root.style.setProperty('--accent-hover', hoverColor)

    // Outline color and thickness (for button borders)
    const outlineColor = settings.outlineColor || '#E2E8F0'
    root.style.setProperty('--outline-color', outlineColor)

    const outlineThickness = settings.outlineThickness ?? 1
    root.style.setProperty('--outline-thickness', `${outlineThickness}px`)

    // Border radius
    if (settings.borderRadius !== undefined) {
      const radius = settings.borderRadius
      root.style.setProperty('--radius-base', `${radius}px`)
      root.style.setProperty('--radius-sm', `${radius * 0.5}px`)
      root.style.setProperty('--radius-md', `${radius * 0.75}px`)
      root.style.setProperty('--radius-lg', `${radius}px`)
      root.style.setProperty('--radius-xl', `${radius * 1.5}px`)
      root.style.setProperty('--radius-2xl', `${radius * 2}px`)
    }

    // Spacing
    if (settings.spacing !== undefined) {
      const spacing = settings.spacing
      root.style.setProperty('--spacing-base', `${spacing}px`)
      // Update spacing scale based on theme preference
      root.style.setProperty('--space-3', `${spacing * 0.75}px`)
      root.style.setProperty('--space-4', `${spacing}px`)
      root.style.setProperty('--space-5', `${spacing * 1.25}px`)
      root.style.setProperty('--space-6', `${spacing * 1.5}px`)
      root.style.setProperty('--space-8', `${spacing * 2}px`)
      root.style.setProperty('--space-10', `${spacing * 2.5}px`)
      root.style.setProperty('--space-12', `${spacing * 3}px`)
      root.style.setProperty('--space-16', `${spacing * 4}px`)
    }

    // Content layout (standard | wide). 'wide' enables edge-to-edge bands
    // with tiered content stages; 'standard' keeps the framed 1400px player.
    const player = document.getElementById('slate-player')
    if (player) {
      player.classList.toggle(
        'content-layout-wide',
        settings.contentLayout === 'wide'
      )
    }

    // Font settings
    if (settings.headingFont || settings.bodyFont || settings.headingFontWeight || settings.bodyFontWeight) {
      this.applyFontSettings(settings.headingFont, settings.bodyFont, settings.headingFontWeight, settings.bodyFontWeight)
    }

    // Custom CSS (user-defined overrides) - always call to handle removal too
    this.applyCustomCss(settings.customCss)
  }

  applyFontSettings(headingFontId, bodyFontId, headingFontWeight, bodyFontWeight) {
    const root = document.documentElement

    // Font family map (CSS font-family values by ID)
    const fontMap = {
      'inter': "'Inter', sans-serif",
      'open-sans': "'Open Sans', sans-serif",
      'roboto': "'Roboto', sans-serif",
      'lato': "'Lato', sans-serif",
      'poppins': "'Poppins', sans-serif",
      'nunito': "'Nunito', sans-serif",
      'work-sans': "'Work Sans', sans-serif",
      'dm-sans': "'DM Sans', sans-serif",
      'source-sans-3': "'Source Sans 3', sans-serif",
      'noto-sans': "'Noto Sans', sans-serif",
      'mulish': "'Mulish', sans-serif",
      'rubik': "'Rubik', sans-serif",
      'playfair-display': "'Playfair Display', serif",
      'merriweather': "'Merriweather', serif",
      'lora': "'Lora', serif",
      'source-serif-pro': "'Source Serif Pro', serif",
      'crimson-pro': "'Crimson Pro', serif",
      'libre-baskerville': "'Libre Baskerville', serif",
      'bitter': "'Bitter', serif",
      'montserrat': "'Montserrat', sans-serif",
      'raleway': "'Raleway', sans-serif",
      'oswald': "'Oswald', sans-serif",
      'bebas-neue': "'Bebas Neue', sans-serif",
      'archivo': "'Archivo', sans-serif",
      'sora': "'Sora', sans-serif",
      'caveat': "'Caveat', cursive",
      'dancing-script': "'Dancing Script', cursive",
      'pacifico': "'Pacifico', cursive",
      'fira-code': "'Fira Code', monospace",
      'jetbrains-mono': "'JetBrains Mono', monospace",
    }

    // Load custom fonts from course settings if present
    const customFonts = this.course?.settings?.customFonts
    if (customFonts && Array.isArray(customFonts)) {
      for (const customFont of customFonts) {
        // Register in fontMap for lookup
        fontMap[customFont.fontId] = customFont.family

        // Inject @font-face CSS (only once per font)
        const styleId = `slate-font-${customFont.fontId}`
        if (!document.getElementById(styleId)) {
          const style = document.createElement('style')
          style.id = styleId
          let css = ''
          for (const variant of customFont.variants) {
            css += `@font-face {
  font-family: '${customFont.familyName}';
  src: url('${variant.url}') format('${variant.format}');
  font-weight: ${variant.weight};
  font-style: ${variant.style};
  font-display: swap;
}\n`
          }
          style.textContent = css
          document.head.appendChild(style)
        }
      }
    }

    const defaultFont = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

    // Apply heading font
    if (headingFontId && fontMap[headingFontId]) {
      root.style.setProperty('--font-family-heading', fontMap[headingFontId])
    } else {
      root.style.setProperty('--font-family-heading', defaultFont)
    }

    // Apply body font
    if (bodyFontId && fontMap[bodyFontId]) {
      root.style.setProperty('--font-family-body', fontMap[bodyFontId])
    } else {
      root.style.setProperty('--font-family-body', defaultFont)
    }

    // Apply heading font weight (default 700)
    root.style.setProperty('--font-weight-heading', headingFontWeight || 700)

    // Apply body font weight (default 400)
    root.style.setProperty('--font-weight-body', bodyFontWeight || 400)
  }

  applyCustomCss(css) {
    // Remove existing custom style tag if present
    const existingStyle = document.getElementById('slate-custom-css')
    if (existingStyle) {
      existingStyle.remove()
    }

    // Create and inject new style tag (sanitized to block dangerous CSS patterns)
    if (css && css.trim()) {
      const style = document.createElement('style')
      style.id = 'slate-custom-css'
      style.textContent = this.sanitizeCss(css)
      document.head.appendChild(style)
    }
    // Re-applying custom CSS must respect an active high-contrast override.
    this._syncCustomCssForContrast()
  }

  /**
   * High contrast is a universal, theme-independent override. A course's custom
   * CSS (and the preset dark/bold themes, which are built on custom CSS) sets
   * hardcoded colors that would fight the HC palette, so the custom-CSS sheet is
   * disabled whenever HC is on and re-enabled when it's off. This is robust to
   * arbitrary author CSS — far cleaner than trying to out-specify it.
   */
  _syncCustomCssForContrast() {
    const style = document.getElementById('slate-custom-css')
    if (style) style.disabled = document.documentElement.classList.contains('slate-hc')
  }

  // Copy theme CSS variables from document root to a code block container
  // This allows AI-generated code to use theme variables like var(--primary-color)
  applyThemeToCodeBlock(container) {
    const root = document.documentElement
    const style = getComputedStyle(root)

    // Copy player theme variables to container
    const playerVars = [
      '--primary-color', '--accent-color', '--accent-hover',
      '--radius-base', '--outline-color'
    ]
    playerVars.forEach(name => {
      const value = style.getPropertyValue(name).trim()
      if (value) container.style.setProperty(name, value)
    })

    // Map player var names to AI prompt names
    const radius = style.getPropertyValue('--radius-base').trim()
    if (radius) container.style.setProperty('--border-radius', radius)

    // Map accent-hover to hover-color for AI-generated code
    const accentHover = style.getPropertyValue('--accent-hover').trim()
    if (accentHover) container.style.setProperty('--hover-color', accentHover)

    // Add semantic colors that AI-generated code expects
    // Use slate scale variables so colors adapt to dark/light themes
    container.style.setProperty('--success-color', '#22c55e')
    container.style.setProperty('--error-color', '#ef4444')
    container.style.setProperty('--text-color', style.getPropertyValue('--slate-800').trim() || '#1e293b')
    container.style.setProperty('--text-muted', style.getPropertyValue('--slate-500').trim() || '#64748b')
    container.style.setProperty('--bg-light', style.getPropertyValue('--slate-50').trim() || '#f8fafc')
    container.style.setProperty('--bg-muted', style.getPropertyValue('--slate-100').trim() || '#f1f5f9')
    container.style.setProperty('--border-color', style.getPropertyValue('--slate-200').trim() || '#e2e8f0')
  }

  setupSidebar() {
    const nav = document.getElementById('player-nav')
    const header = document.getElementById('player-header')
    const playerBody = document.getElementById('player-body')
    if (!nav || !header) return

    // Course menu disabled: keep the sidebar's toggle button, mobile toggle,
    // overlay and close button out of the DOM entirely. The .nav-menu-hidden
    // class (set in render) collapses the now-empty <nav> so content fills the
    // freed width.
    if (this.course.settings.showNavigation === false) return

    // Apply saved collapsed state
    if (this.sidebarCollapsed) {
      nav.classList.add('collapsed')
    }

    // Skip creating elements if they already exist (hot-reload safe)
    if (document.querySelector('.nav-toggle')) return

    // Desktop toggle button
    const toggleBtn = document.createElement('button')
    toggleBtn.className = 'nav-toggle'
    toggleBtn.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 18l-6-6 6-6"/>
    </svg>`
    toggleBtn.setAttribute('aria-label', this.t('nav.toggleNav'))
    playerBody.appendChild(toggleBtn)

    toggleBtn.addEventListener('click', () => this.toggleSidebar())

    // Mobile nav button in header-left section
    const headerLeft = document.getElementById('header-left')
    const mobileBtn = document.createElement('button')
    mobileBtn.className = 'mobile-nav-toggle'
    mobileBtn.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12h18M3 6h18M3 18h18"/>
    </svg>`
    mobileBtn.setAttribute('aria-label', this.t('nav.openMenu'))
    if (headerLeft) headerLeft.appendChild(mobileBtn)

    mobileBtn.addEventListener('click', () => this.openMobileNav())

    // Mobile overlay
    const overlay = document.createElement('div')
    overlay.className = 'nav-overlay'
    const playerRoot = document.getElementById('slate-player') || document.body
    playerRoot.appendChild(overlay)

    overlay.addEventListener('click', () => this.closeMobileNav())

    // Close button in nav
    const closeBtn = document.createElement('button')
    closeBtn.className = 'nav-close'
    closeBtn.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 6L6 18M6 6l12 12"/>
    </svg>`
    closeBtn.setAttribute('aria-label', this.t('nav.closeMenu'))
    nav.prepend(closeBtn)

    closeBtn.addEventListener('click', () => this.closeMobileNav())
  }

  toggleSidebar() {
    const nav = document.getElementById('player-nav')
    this.sidebarCollapsed = !this.sidebarCollapsed
    nav.classList.toggle('collapsed', this.sidebarCollapsed)

    // Save preference (skip in SCORM mode - shared localStorage causes issues)
    if (!this.scorm) {
      safeStorage.setItem('slate-nav-collapsed', this.sidebarCollapsed)
    }
  }

  openMobileNav() {
    const nav = document.getElementById('player-nav')
    const overlay = document.querySelector('.nav-overlay')
    nav.classList.add('open')
    overlay.classList.add('visible')
    document.body.style.overflow = 'hidden'

    // Focus the first reachable menu item for accessibility. With collapsible
    // sections, lessons inside collapsed sections are visibility-hidden and
    // can't take focus, so fall to the first visible lesson or section toggle
    // in document order.
    const firstItem = nav.querySelector('.nav-section:not(.nav-collapsed) .nav-lesson, .nav-section-toggle')
    if (firstItem) firstItem.focus()
  }

  closeMobileNav() {
    const nav = document.getElementById('player-nav')
    const overlay = document.querySelector('.nav-overlay')
    nav.classList.remove('open')
    overlay.classList.remove('visible')
    document.body.style.overflow = ''

    // Clear search when closing mobile nav
    if (this.isSearching) {
      this.clearSearch()
    }
  }

  // ============================================
  // SCROLL INDICATOR
  // ============================================

  /**
   * Setup universal scroll indicator for content
   */
  setupScrollIndicator() {
    // Check if scroll indicator is enabled (default to true)
    if (this.course?.settings?.showScrollIndicator === false) return

    // Don't create if already exists
    if (document.getElementById('scroll-indicator')) return

    const playerBody = document.getElementById('player-body')
    if (!playerBody) return

    // Create indicator element
    const indicator = document.createElement('div')
    indicator.id = 'scroll-indicator'
    indicator.className = 'scroll-indicator'
    indicator.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    `
    playerBody.appendChild(indicator)

    // Get content container
    const content = document.getElementById('player-content')
    if (!content) return

    // Check scroll position
    this.checkScrollIndicator = () => {
      const scrollTop = content.scrollTop
      const scrollHeight = content.scrollHeight
      const clientHeight = content.clientHeight
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight

      // Show if more than 150px to scroll
      if (distanceFromBottom > 150) {
        indicator.classList.add('visible')
      } else {
        indicator.classList.remove('visible')
      }
    }

    // Listen for scroll
    content.addEventListener('scroll', this.checkScrollIndicator)

    // Listen for resize
    window.addEventListener('resize', this.checkScrollIndicator)

    // Click to scroll down
    indicator.addEventListener('click', () => {
      content.scrollBy({ top: 300, behavior: 'smooth' })
    })

    // Initial check
    this.checkScrollIndicator()
  }

  /**
   * Update scroll indicator after content changes
   */
  updateScrollIndicator() {
    if (this.checkScrollIndicator) {
      // Check after layout settles
      requestAnimationFrame(() => {
        this.checkScrollIndicator()
        // Check again after images may have loaded
        setTimeout(this.checkScrollIndicator, 500)
      })
    }
  }

  // ============================================
  // NAVIGATION UI
  // ============================================

  // ============================================
  // COLLAPSIBLE COURSE MENU (settings.collapsibleSections)
  // ============================================

  isCollapsibleMenuEnabled() {
    return this.course?.settings?.collapsibleSections === true
  }

  /** Stable key for a section's expanded/collapsed state across re-renders. */
  navSectionKey(section, index) {
    return section?.id || `section-${index}`
  }

  /**
   * Auto-expand the section that contains the learner's current position.
   * Runs at the top of renderNavigation(). Expansion happens only when the
   * position changed since the last render, so re-renders triggered by other
   * state (language switch, viewed updates) respect a manual collapse of the
   * active section. Expanded state is runtime-only by design: on resume, the
   * restored position re-expands its section here.
   *
   * COUPLING: "the learner navigated" is inferred from a position delta at
   * render time, not from the navigation events themselves. This is safe only
   * because every position change currently routes through a renderNavigation()
   * with no competing path. If a future change repositions WITHOUT a user
   * navigation (deep-link restore, branching jump, server-driven reposition),
   * it would re-expand a section the learner deliberately collapsed — at that
   * point, move the expand call onto the actual nav events instead.
   */
  syncExpandedNavSections() {
    if (!this.isCollapsibleMenuEnabled()) return
    if (this.showingCoverPage) {
      this.lastNavPositionKey = 'cover'
      return
    }
    const section = this.course?.sections?.[this.currentSectionIndex]
    if (!section) return
    const sectionKey = this.navSectionKey(section, this.currentSectionIndex)
    const positionKey = `${sectionKey}:${this.showingConclusionPage ? 'conclusion' : this.currentLessonIndex}`
    if (this.lastNavPositionKey !== positionKey) {
      this.expandedNavSections.add(sectionKey)
      this.lastNavPositionKey = positionKey
    }
  }

  renderNavigation() {
    const nav = document.getElementById('player-nav')
    if (!nav) return

    // Auto-expand the current section before building markup (no-op unless
    // the course menu is collapsible)
    this.syncExpandedNavSections()

    // Preserve close button if it exists
    const closeBtn = nav.querySelector('.nav-close')

    // Build the search input. It lives INSIDE the header so the header reads as
    // one substantial block with a single divider, rather than the search
    // sitting below as a separate band with its own border.
    const searchInputHtml = this.isSearchEnabled() ? `
      <div class="nav-search">
        <div class="nav-search-wrapper">
          <svg class="nav-search-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.3-4.3"/>
          </svg>
          <input type="search"
                 id="nav-search-input"
                 class="nav-search-input"
                 placeholder="${escapeHtml(this.t('search.placeholder'))}"
                 aria-label="${escapeHtml(this.t('search.placeholder'))}"
                 role="searchbox" />
          <button id="nav-search-clear"
                  class="nav-search-clear"
                  type="button"
                  hidden
                  aria-label="${escapeHtml(this.t('search.clear'))}">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>
    ` : ''

    // Build nav header with course title (translated); search sits inside it.
    const courseTitle = escapeHtml(this.getTranslatedCourseTitle())
    const navHeader = `
      <div class="nav-header">
        <div class="nav-header-subtitle">${escapeHtml(this.t('nav.courseMenu'))}</div>
        <div class="nav-header-title">${courseTitle}</div>
        ${searchInputHtml}
      </div>
    `

    // Search results container — kept as a direct nav child (not inside the
    // header) so it can flex to fill the list area and replace .nav-sections
    // while searching.
    const searchHtml = this.isSearchEnabled()
      ? `<div id="nav-search-results" class="nav-search-results" aria-live="polite"></div>`
      : ''

    // Cover page nav entry (rendered above all sections, not inside any section)
    const coverLesson = this.getCoverLesson()
    const coverNavHtml = coverLesson ? (() => {
      const lang = this.selectedLanguage || 'en'
      const courseTrans = this.course.translations?.[lang]
      const menuLabel = courseTrans?.settings?.coverPage?.menuLabel
        ?? this.course.settings?.coverPage?.menuLabel
        ?? this.t('cover.defaultMenuLabel')
      const isCoverActive = this.showingCoverPage === true
      return `
        <div class="nav-section nav-section-cover">
          <ul class="nav-lessons" role="list">
            <li class="nav-lesson ${isCoverActive ? 'active' : ''} ${this.coverViewed ? 'viewed' : ''}"
                data-cover="true"
                tabindex="0"
                role="button"
                title="${escapeHtml(menuLabel)}"
                aria-current="${isCoverActive ? 'true' : 'false'}">
              <span class="nav-lesson-title">${escapeHtml(menuLabel)}</span>
            </li>
          </ul>
        </div>
      `
    })() : ''

    // Section wrapper shared by regular and assessment sections. With
    // collapsibleSections on, the title becomes a toggle button and the lesson
    // list collapses (animated via the CSS grid-rows trick — see styles.css).
    // `sectionTitle` and `lessonsHtml` arrive pre-escaped from the callers.
    const collapsibleMenu = this.isCollapsibleMenuEnabled()
    const wrapNavSection = (section, sIndex, sectionTitle, lessonsHtml, extraClass = '') => {
      if (!collapsibleMenu) {
        return `
        <div class="nav-section ${extraClass}">
          <div class="nav-section-title">${sectionTitle}</div>
          ${lessonsHtml}
        </div>
      `
      }
      const key = this.navSectionKey(section, sIndex)
      const isExpanded = this.expandedNavSections.has(key)
      // The dot marks the section holding the current lesson; CSS shows it
      // only while the section is collapsed (the active row shows otherwise).
      const containsActive = sIndex === this.currentSectionIndex && !this.showingCoverPage
      const bodyId = `nav-section-body-${sIndex}`
      return `
        <div class="nav-section nav-collapsible ${isExpanded ? '' : 'nav-collapsed'} ${extraClass}">
          <button class="nav-section-toggle"
                  type="button"
                  aria-expanded="${isExpanded ? 'true' : 'false'}"
                  aria-controls="${bodyId}"
                  data-nav-section-key="${escapeHtml(key)}">
            <span class="nav-section-toggle-title">${sectionTitle}</span>
            ${containsActive ? '<span class="nav-section-active-dot" aria-hidden="true"></span>' : ''}
            <svg class="nav-section-chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="nav-section-body" id="${bodyId}">
            <div class="nav-section-body-inner">
              ${lessonsHtml}
            </div>
          </div>
        </div>
      `
    }

    const sectionsHtml = coverNavHtml + this.course.sections.map((section, sIndex) => {
      // Skip cover sections in the main sidebar — cover nav is rendered separately above
      if (section.isCoverSection === true) return ''
      const isAssessment = section.isAssessment === true
      const sectionTitle = escapeHtml(this.getTranslatedSectionTitle(section))

      // For assessment sections, show single "Assessment" item
      if (isAssessment && this.hasAssessment()) {
        const isActive = sIndex === this.currentSectionIndex
        const isPassed = this.hasPassedAssessment()
        const isLocked = this.isAssessmentLocked()
        const assessmentLesson = section.lessons.find(l => !this.isConclusionLesson(l) && !this.isCoverLesson(l)) || section.lessons[0]
        const assessmentTitle = this.getTranslatedLessonTitle(assessmentLesson)
        const assessmentLockHint = this.getNavLockTitle(sIndex, 0, assessmentTitle)

        // Conclusion page nav item (if exists) — locked until assessment is passed
        const conclusionLesson = this.getConclusionLesson()
        const conclusionNavHtml = conclusionLesson ? (() => {
          const isConclusionActive = isActive && this.showingConclusionPage
          const isConclusionLocked = !isPassed
          const conclusionTitle = escapeHtml(this.getTranslatedLessonTitle(conclusionLesson))
          return `
              <li class="nav-lesson ${isConclusionActive ? 'active' : ''} ${this.conclusionViewed ? 'viewed' : ''} ${isConclusionLocked ? 'nav-locked' : ''}"
                  data-conclusion="true"
                  tabindex="${isConclusionLocked ? '-1' : '0'}"
                  role="button"
                  ${isConclusionLocked ? 'aria-disabled="true"' : ''}
                  title="${conclusionTitle}"
                  aria-current="${isConclusionActive ? 'true' : 'false'}">
                <span class="nav-lesson-title">${conclusionTitle}</span>
                ${isConclusionLocked ? '<svg class="nav-lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : ''}
              </li>`
        })() : ''

        const assessmentLessonsHtml = `
            <ul class="nav-lessons" role="list">
              <li class="nav-lesson ${isActive && !this.showingConclusionPage && !this.showingCoverPage ? 'active' : ''} ${isPassed ? 'viewed' : ''} ${isLocked ? 'nav-locked' : ''}"
                  data-section="${sIndex}"
                  data-lesson="0"
                  tabindex="${isLocked ? '-1' : '0'}"
                  role="button"
                  ${isLocked ? 'aria-disabled="true"' : ''}
                  title="${escapeHtml(isLocked ? assessmentLockHint : assessmentTitle)}"
                  aria-current="${isActive && !this.showingConclusionPage && !this.showingCoverPage ? 'true' : 'false'}">
                <span class="nav-lesson-title">
                  ${escapeHtml(assessmentTitle)}
                </span>
                ${isLocked && !isPassed ? '<svg class="nav-lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : ''}
              </li>
              ${conclusionNavHtml}
            </ul>
        `
        return wrapNavSection(section, sIndex, sectionTitle, assessmentLessonsHtml, 'nav-section-assessment')
      }

      const lessonsHtml = `
          <ul class="nav-lessons" role="list">
            ${section.lessons.map((lesson, lIndex) => ({ lesson, lIndex })).filter(({ lesson }) => !this.isConclusionLesson(lesson) && !this.isCoverLesson(lesson)).map(({ lesson, lIndex }) => {
              const isActive = sIndex === this.currentSectionIndex && lIndex === this.currentLessonIndex
              const isViewed = this.viewedLessons.has(lesson.id)
              const isGateLocked = this.isForwardNavigationGated(sIndex, lIndex)
              const isLocked = isGateLocked || !this.isLessonAccessible(sIndex, lIndex)
              const lessonTitle = this.getTranslatedLessonTitle(lesson)
              const lockHint = this.getNavLockTitle(sIndex, lIndex, lessonTitle)
              return `
              <li class="nav-lesson ${isActive && !this.showingCoverPage && !this.showingConclusionPage ? 'active' : ''} ${isViewed ? 'viewed' : ''} ${isLocked ? 'nav-locked' : ''}"
                  data-section="${sIndex}"
                  data-lesson="${lIndex}"
                  tabindex="${isLocked ? '-1' : '0'}"
                  role="button"
                  ${isLocked ? 'aria-disabled="true"' : ''}
                  title="${escapeHtml(isLocked ? lockHint : lessonTitle)}"
                  aria-current="${isActive && !this.showingCoverPage && !this.showingConclusionPage ? 'true' : 'false'}">
                <span class="nav-lesson-title">${escapeHtml(lessonTitle)}</span>
                ${isLocked ? '<svg class="nav-lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : ''}
              </li>
            `}).join('')}
          </ul>
      `
      return wrapNavSection(section, sIndex, sectionTitle, lessonsHtml)
    }).join('')

    // Exit Course footer (shown whenever the setting is enabled)
    // All dynamic text is escaped via escapeHtml() — no untrusted content
    const exitFooterHtml = this.course.settings.showExitCourse
      ? `<div class="nav-exit-footer">
           <button class="nav-exit-btn" type="button" aria-label="${escapeHtml(this.t('nav.exitCourse'))}">
             <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
               <polyline points="16 17 21 12 16 7"/>
               <line x1="21" y1="12" x2="9" y2="12"/>
             </svg>
             ${escapeHtml(this.t('nav.exitCourse'))}
           </button>
         </div>`
      : ''

    // Combine header, search, sections, and exit footer (all content is escaped)
    nav.innerHTML = navHeader + searchHtml + `<div class="nav-sections">${sectionsHtml}</div>` + exitFooterHtml

    // Re-add close button
    if (closeBtn) {
      nav.prepend(closeBtn)
    }

    // Setup exit button handler
    const exitBtn = nav.querySelector('.nav-exit-btn')
    if (exitBtn) {
      exitBtn.addEventListener('click', () => this.handleExitCourse())
    }

    // Setup search handlers if enabled
    if (this.isSearchEnabled()) {
      this.setupSearchHandlers()
    }

    // Add click and keyboard handlers
    nav.querySelectorAll('.nav-lesson').forEach(el => {
      const handleNav = () => {
        // Cover page nav item — re-render the cover
        if (el.dataset.cover === 'true') {
          this.showingCoverPage = true
          this.showingConclusionPage = false
          this.renderCurrentLesson()
          this.renderNavigation()
          this.updateNavButtons()
          this.closeMobileNav()
          return
        }

        // Conclusion page nav item — navigate to conclusion page directly
        if (el.dataset.conclusion === 'true') {
          if (!this.hasPassedAssessment()) return  // Locked
          this.showingConclusionPage = true
          this.currentSectionIndex = this.assessmentSectionIndex
          this.currentLessonIndex = 0
          this.renderCurrentLesson()
          this.renderNavigation()
          this.updateNavButtons()
          this.closeMobileNav()
          return
        }

        this.goToLesson(
          parseInt(el.dataset.section),
          parseInt(el.dataset.lesson)
        )
        this.closeMobileNav()
      }

      el.addEventListener('click', handleNav)
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleNav()
        }
      })
    })

    // Collapsible section toggles. Class flips happen in place (no re-render)
    // so the CSS grid-rows transition can animate; the Set keeps the state for
    // the next full re-render.
    nav.querySelectorAll('.nav-section-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.navSectionKey
        const sectionEl = btn.closest('.nav-section')
        const expand = btn.getAttribute('aria-expanded') !== 'true'
        if (expand) this.expandedNavSections.add(key)
        else this.expandedNavSections.delete(key)
        btn.setAttribute('aria-expanded', expand ? 'true' : 'false')
        if (sectionEl) sectionEl.classList.toggle('nav-collapsed', !expand)
      })
    })
  }

  // ============================================
  // EXIT COURSE (LMS)
  // ============================================

  /**
   * Handle the Exit Course button click.
   * Saves progress, terminates SCORM session, attempts to close window,
   * and shows a fallback message if window.close() is blocked.
   */
  handleExitCourse() {
    // Save progress and terminate SCORM session if running in an LMS
    if (this.scorm && this.isLmsMode()) {
      this.saveProgress()
      this.scorm.LMSFinish('')
    }

    // Attempt to close the window/tab
    window.close()

    // If still open after 500ms, show fallback message
    setTimeout(() => this.showExitFallbackMessage(), 500)
  }

  /**
   * Show a fallback message when window.close() is blocked
   * (e.g., when the LMS opens the course in the same tab)
   */
  showExitFallbackMessage() {
    const content = document.getElementById('player-content')
    if (!content) return

    // Close mobile nav if open (clears body scroll lock and overlay)
    this.closeMobileNav()

    // All text is from UI_STRINGS (static translations), safe for innerHTML
    content.innerHTML = `
      <div class="exit-fallback" role="status" aria-live="polite">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="exit-fallback-icon">
          <circle cx="12" cy="12" r="10"/>
          <path d="M9 12l2 2 4-4"/>
        </svg>
        <h2 class="exit-fallback-title">${escapeHtml(this.t('nav.exitFallbackTitle'))}</h2>
        <p class="exit-fallback-message">${escapeHtml(this.t('nav.exitFallbackMessage'))}</p>
      </div>
    `

    // Hide all navigation chrome for a clean final state
    const nav = document.getElementById('player-nav')
    const footer = document.getElementById('player-footer')
    const navToggle = document.querySelector('.nav-toggle')
    const mobileToggle = document.querySelector('.mobile-nav-toggle')
    const overlay = document.querySelector('.nav-overlay')
    const scrollIndicator = document.getElementById('scroll-indicator')
    if (nav) nav.style.display = 'none'
    if (footer) footer.style.display = 'none'
    if (navToggle) navToggle.style.display = 'none'
    if (mobileToggle) mobileToggle.style.display = 'none'
    if (overlay) overlay.style.display = 'none'
    if (scrollIndicator) scrollIndicator.style.display = 'none'
  }

  // ============================================
  // SEARCH FUNCTIONALITY
  // ============================================

  /**
   * Check if search is enabled for this course
   */
  isSearchEnabled() {
    return this.course?.settings?.enableSearch !== false
  }

  /**
   * Check if the player is running inside an LMS (not standalone or preview)
   */
  isLmsMode() {
    return this.scorm && typeof this.scorm.isStandaloneMode === 'function' && !this.scorm.isStandaloneMode()
  }

  /**
   * Build the search index from course content
   * Called at init and when language changes
   */
  buildSearchIndex() {
    this.searchIndex = []

    if (!this.course?.sections) return

    this.course.sections.forEach((section, sectionIndex) => {
      // Skip assessment sections
      if (section.isAssessment) return

      section.lessons.forEach((lesson, lessonIndex) => {
        if (this.isConclusionLesson(lesson) || this.isCoverLesson(lesson)) return  // Skip conclusion/cover in search

        const lessonTitle = this.getTranslatedLessonTitle(lesson)
        const lessonId = lesson.id

        // Index lesson title
        this.searchIndex.push({
          sectionIndex,
          lessonIndex,
          lessonId,
          lessonTitle,
          blockId: null,
          blockType: 'lesson-title',
          text: lessonTitle.toLowerCase(),
          originalText: lessonTitle,
          context: 'Lesson'
        })

        // Index blocks (with translated content)
        lesson.blocks.forEach(block => {
          // Get translated content for this block
          const translatedContent = this.getTranslatedBlockContent(block, lesson)
          const blockWithTranslation = { ...block, content: translatedContent }
          this.indexBlock(blockWithTranslation, sectionIndex, lessonIndex, lessonId, lessonTitle)
        })
      })
    })
  }

  /**
   * Index a single block and its nested content
   */
  indexBlock(block, sectionIndex, lessonIndex, lessonId, lessonTitle) {
    const addEntry = (text, context, blockId = block.id, blockType = block.type) => {
      if (!text || typeof text !== 'string') return
      // Strip HTML and decode entities
      const stripped = this.stripHtml(text)
      if (stripped.length < 2) return  // Skip very short text

      this.searchIndex.push({
        sectionIndex,
        lessonIndex,
        lessonId,
        lessonTitle,
        blockId,
        blockType,
        text: stripped.toLowerCase(),
        originalText: stripped,
        context
      })
    }

    switch (block.type) {
      case 'text':
        addEntry(block.content?.html, 'Content')
        break

      case 'knowledge-check':
        addEntry(block.content?.question, 'Question')
        // Only index MC/MS option text (visible to learners).
        // FIB acceptedAnswers are excluded — indexing them would expose correct answers via search.
        block.content?.options?.forEach(opt => {
          addEntry(opt.text, 'Answer option')
        })
        addEntry(block.content?.feedback?.correct, 'Feedback')
        addEntry(block.content?.feedback?.incorrect, 'Feedback')
        break

      case 'accordion':
        block.content?.items?.forEach(item => {
          addEntry(item.title, 'Accordion title')
          item.items?.forEach(subItem => {
            if (subItem.type === 'text') {
              addEntry(subItem.content, 'Accordion content')
            }
          })
        })
        break

      case 'tabs':
        block.content?.items?.forEach(item => {
          addEntry(item.label, 'Tab label')
          item.items?.forEach(subItem => {
            if (subItem.type === 'text') {
              addEntry(subItem.content, 'Tab content')
            }
          })
        })
        break

      case 'card':
        addEntry(block.content?.title, 'Card title')
        addEntry(block.content?.subtitle, 'Card subtitle')
        block.content?.items?.forEach(item => {
          if (item.type === 'text') {
            addEntry(item.content, 'Card content')
          }
        })
        break

      case 'flip-card':
        addEntry(block.content?.front?.title, 'Card front')
        addEntry(block.content?.front?.subtitle, 'Card front')
        addEntry(block.content?.back?.title, 'Card back')
        addEntry(block.content?.back?.subtitle, 'Card back')
        block.content?.front?.items?.forEach(item => {
          if (item.type === 'text') addEntry(item.content, 'Card front')
        })
        block.content?.back?.items?.forEach(item => {
          if (item.type === 'text') addEntry(item.content, 'Card back')
        })
        break

      case 'card-carousel':
        block.content?.cards?.forEach(card => {
          addEntry(card.title, 'Carousel card')
          addEntry(card.subtitle, 'Carousel card')
          card.items?.forEach(item => {
            if (item.type === 'text') addEntry(item.content, 'Carousel card')
          })
        })
        break

      case 'flip-card-carousel':
        block.content?.cards?.forEach(card => {
          addEntry(card.front?.title, 'Flip carousel front')
          addEntry(card.front?.subtitle, 'Flip carousel front')
          card.front?.items?.forEach(item => {
            if (item.type === 'text') addEntry(item.content, 'Flip carousel front')
          })
          addEntry(card.back?.title, 'Flip carousel back')
          addEntry(card.back?.subtitle, 'Flip carousel back')
          card.back?.items?.forEach(item => {
            if (item.type === 'text') addEntry(item.content, 'Flip carousel back')
          })
        })
        break

      case 'note':
        addEntry(block.content?.html, 'Note')
        break

      case 'table':
        block.content?.rows?.forEach(row => {
          row.cells?.forEach(cell => {
            addEntry(cell.html, 'Table')
          })
        })
        if (block.content?.caption) {
          addEntry(block.content.caption, 'Table caption')
        }
        break

      case 'button':
        addEntry(block.content?.text, 'Button')
        break

      case 'image':
        addEntry(block.content?.caption, 'Image caption')
        addEntry(block.content?.alt, 'Image description')
        if (block.content?.hotspots) {
          block.content.hotspots.forEach(hs => {
            addEntry(hs.label, 'Hotspot')
            addEntry(hs.description?.replace(/<[^>]*>/g, ''), 'Hotspot')
          })
        }
        break

      case 'video':
      case 'audio':
        addEntry(block.content?.caption, 'Media caption')
        break

      case 'document':
        addEntry(block.content?.title, 'Document')
        addEntry(block.content?.description, 'Document')
        addEntry(block.content?.filename, 'Document')
        break

      case 'iframe':
        addEntry(block.content?.title, 'Embed')
        break

      case 'layout':
        // Index nested blocks in layout cells
        block.content?.cells?.forEach(cell => {
          cell.blocks?.forEach(nestedBlock => {
            this.indexBlock(nestedBlock, sectionIndex, lessonIndex, lessonId, lessonTitle)
          })
        })
        break

      case 'code':
        // Index nested blocks in code blocks (blocks mode)
        if (block.content?.mode === 'blocks' && block.content?.blocks) {
          block.content.blocks.forEach(nestedBlock => {
            this.indexBlock(nestedBlock, sectionIndex, lessonIndex, lessonId, lessonTitle)
          })
        }
        break
    }
  }

  /**
   * Strip HTML tags and decode entities
   */
  stripHtml(html) {
    if (!html) return ''
    const div = document.createElement('div')
    div.innerHTML = html
    return div.textContent || div.innerText || ''
  }

  /**
   * Perform search and return grouped results
   */
  performSearch(query) {
    if (!query || query.length < 2) return []

    // Escape special regex characters
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(escaped, 'gi')
    const lowerQuery = query.toLowerCase()

    const results = []
    const lessonGroups = new Map()

    this.searchIndex.forEach(entry => {
      if (entry.text.includes(lowerQuery)) {
        const key = `${entry.sectionIndex}-${entry.lessonIndex}`
        if (!lessonGroups.has(key)) {
          lessonGroups.set(key, {
            sectionIndex: entry.sectionIndex,
            lessonIndex: entry.lessonIndex,
            lessonId: entry.lessonId,
            lessonTitle: entry.lessonTitle,
            items: []
          })
        }

        // Only keep first 3 matches per lesson
        const group = lessonGroups.get(key)
        if (group.items.length < 3) {
          // Generate snippet with highlight
          const snippet = this.createSearchSnippet(entry.originalText, regex)
          group.items.push({
            blockId: entry.blockId,
            blockType: entry.blockType,
            context: entry.context,
            snippet
          })
        }
      }
    })

    // Filter out locked lessons from search results
    if (this.isLockedNavigation()) {
      for (const [key, group] of lessonGroups) {
        if (this.isForwardNavigationGated(group.sectionIndex, group.lessonIndex) || !this.isLessonAccessible(group.sectionIndex, group.lessonIndex)) {
          lessonGroups.delete(key)
        }
      }
    }

    return Array.from(lessonGroups.values())
  }

  /**
   * Create a search result snippet with highlighted match
   */
  createSearchSnippet(text, regex) {
    const maxLength = 100
    const match = text.match(regex)
    if (!match) return escapeHtml(text.slice(0, maxLength))

    const matchIndex = text.toLowerCase().indexOf(match[0].toLowerCase())
    let start = Math.max(0, matchIndex - 40)
    let end = Math.min(text.length, matchIndex + match[0].length + 40)

    // Adjust to word boundaries
    if (start > 0) {
      const spaceIndex = text.indexOf(' ', start)
      if (spaceIndex !== -1 && spaceIndex < matchIndex) start = spaceIndex + 1
    }
    if (end < text.length) {
      const spaceIndex = text.lastIndexOf(' ', end)
      if (spaceIndex > matchIndex + match[0].length) end = spaceIndex
    }

    let snippet = text.slice(start, end)
    if (start > 0) snippet = '...' + snippet
    if (end < text.length) snippet = snippet + '...'

    // Escape HTML and add mark tags
    snippet = escapeHtml(snippet)
    const escapedMatch = escapeHtml(match[0])
    snippet = snippet.replace(new RegExp(escapedMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      '<mark>$&</mark>')

    return snippet
  }

  /**
   * Render search results in the navigation sidebar
   */
  renderSearchResults(results) {
    const container = document.getElementById('nav-search-results')
    if (!container) return

    if (results.length === 0) {
      container.innerHTML = `
        <div class="search-no-results">
          ${escapeHtml(this.t('search.noResults', { query: this.searchQuery }))}
        </div>
      `
      return
    }

    const html = results.map(group => `
      <div class="search-result-group">
        <div class="search-result-lesson">${escapeHtml(group.lessonTitle)}</div>
        ${group.items.map(item => `
          <div class="search-result-item"
               data-section="${group.sectionIndex}"
               data-lesson="${group.lessonIndex}"
               data-block="${item.blockId || ''}"
               tabindex="0"
               role="button">
            <div class="search-result-snippet">${item.snippet}</div>
            <div class="search-result-context">${escapeHtml(item.context)}</div>
          </div>
        `).join('')}
      </div>
    `).join('')

    container.innerHTML = html

    // Add click handlers
    container.querySelectorAll('.search-result-item').forEach(el => {
      const handler = () => {
        this.navigateToSearchResult(
          parseInt(el.dataset.section),
          parseInt(el.dataset.lesson),
          el.dataset.block
        )
      }
      el.addEventListener('click', handler)
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handler()
        }
      })
    })
  }

  /**
   * Navigate to a search result and highlight the content
   */
  navigateToSearchResult(sectionIndex, lessonIndex, blockId) {
    // Store query BEFORE any cleanup that might clear it
    const queryToHighlight = this.searchQuery

    // Navigate to the lesson
    this.goToLesson(sectionIndex, lessonIndex)
    this.closeMobileNav()

    // Clear search mode UI
    this.exitSearchMode()

    // Wait for render to complete, then scroll and highlight
    // renderCurrentLesson has 150ms delay, so we need at least 400ms total
    setTimeout(() => {
      if (blockId && queryToHighlight) {
        const block = document.querySelector(`[data-block-id="${blockId}"]`)
        if (block) {
          // Scroll to block
          block.scrollIntoView({ behavior: 'smooth', block: 'center' })

          // Add temporary highlight
          block.classList.add('search-highlight-block')

          // Highlight search terms in text content
          this.highlightSearchTermsInBlock(block, queryToHighlight)

          // Remove block outline after animation
          setTimeout(() => {
            block.classList.remove('search-highlight-block')
          }, 2000)
        }
      }
    }, 400)
  }

  /**
   * Highlight search terms within a block's text content
   * @param {Element} block - The block element to highlight within
   * @param {string} searchQuery - The search query to highlight (optional, uses this.searchQuery if not provided)
   */
  highlightSearchTermsInBlock(block, searchQuery = this.searchQuery) {
    if (!searchQuery || searchQuery.length < 2) return

    const query = searchQuery.toLowerCase()
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escaped})`, 'gi')

    // Find all text nodes in the block
    const textNodes = []
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null)
    let node
    while (node = walker.nextNode()) {
      // Skip script, style tags and empty nodes
      const parent = node.parentElement
      if (!parent) continue
      const tagName = parent.tagName.toLowerCase()
      if (tagName === 'script' || tagName === 'style') continue
      if (!node.textContent.toLowerCase().includes(query)) continue
      textNodes.push(node)
    }

    // Process each text node - wrap matches in mark elements
    textNodes.forEach(textNode => {
      const text = textNode.textContent
      const parts = text.split(regex)

      // If no split occurred, no match
      if (parts.length <= 1) return

      // Build fragment with highlighted matches
      const fragment = document.createDocumentFragment()
      parts.forEach((part, i) => {
        if (part === '') return
        // Odd indices are the captured matches
        if (i % 2 === 1) {
          const mark = document.createElement('mark')
          mark.className = 'search-highlight-term'
          mark.textContent = part
          fragment.appendChild(mark)
        } else {
          fragment.appendChild(document.createTextNode(part))
        }
      })

      // Replace the text node
      if (fragment.childNodes.length > 0) {
        textNode.parentNode.replaceChild(fragment, textNode)
      }
    })

    // Remove term highlights after a delay
    setTimeout(() => {
      block.querySelectorAll('mark.search-highlight-term').forEach(mark => {
        const text = document.createTextNode(mark.textContent)
        mark.parentNode.replaceChild(text, mark)
      })
    }, 5000)
  }

  /**
   * Enter search mode - show search results and hide normal nav
   */
  enterSearchMode() {
    if (this.isSearching) return
    this.isSearching = true
    const nav = document.getElementById('player-nav')
    if (nav) nav.classList.add('searching')
  }

  /**
   * Exit search mode - hide search results and show normal nav
   */
  exitSearchMode() {
    this.isSearching = false
    const nav = document.getElementById('player-nav')
    if (nav) nav.classList.remove('searching')

    const results = document.getElementById('nav-search-results')
    if (results) results.innerHTML = ''
  }

  /**
   * Clear search completely (query and results)
   */
  clearSearch() {
    this.searchQuery = ''
    const input = document.getElementById('nav-search-input')
    if (input) input.value = ''

    const clearBtn = document.getElementById('nav-search-clear')
    if (clearBtn) clearBtn.hidden = true

    this.exitSearchMode()
  }

  /**
   * Handle search input with debounce
   */
  handleSearchInput(value) {
    this.searchQuery = value.trim()

    const clearBtn = document.getElementById('nav-search-clear')
    if (clearBtn) clearBtn.hidden = !this.searchQuery

    // Clear existing timer
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer)
    }

    if (!this.searchQuery || this.searchQuery.length < 2) {
      this.exitSearchMode()
      return
    }

    // Debounce search
    this.searchDebounceTimer = setTimeout(() => {
      this.enterSearchMode()
      const results = this.performSearch(this.searchQuery)
      this.renderSearchResults(results)
    }, 300)
  }

  /**
   * Setup search UI event handlers
   */
  setupSearchHandlers() {
    const input = document.getElementById('nav-search-input')
    const clearBtn = document.getElementById('nav-search-clear')

    if (input) {
      input.addEventListener('input', (e) => {
        this.handleSearchInput(e.target.value)
      })

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.clearSearch()
          input.blur()
        }
      })
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.clearSearch()
        input?.focus()
      })
    }
  }

  // ============================================
  // LESSON & CONTENT RENDERING
  // ============================================

  renderCurrentLesson() {
    const container = document.getElementById('player-content')

    // Decide cover state BEFORE the fade setTimeout so subsequent
    // renderNavigation() calls see the right state.
    this._resolveInitialCoverState()
    const shouldShowCover = this.showingCoverPage === true

    // Clean up event listeners from previous lesson before rendering new content
    this.runCleanup()

    // Close the settings pane if it's open across a lesson navigation (covers
    // programmatic nav that doesn't route through the pane's own close paths;
    // no-ops when the pane is absent or already closed). Skipped during a
    // language relocalization, which re-renders the same lesson with the pane open.
    if (!this._relocalizing) this.closeSettings()

    // Fade out animation
    container.style.opacity = '0'
    container.style.transform = 'translateY(8px)'

    setTimeout(() => {
      container.innerHTML = ''

      // Reset the interaction gate's per-lesson view state. completedInteractions
      // is cumulative (and persisted); the target/seen maps describe only the
      // top-level interactive blocks currently mounted, so they rebuild on each
      // lesson render as those blocks re-register during init.
      this.interactionTargets.clear()
      this.interactionSeen.clear()

      // Cover decision was made synchronously above (see shouldShowCover)
      if (shouldShowCover) {
        this.renderCoverPage(container)
        requestAnimationFrame(() => {
          container.style.opacity = '1'
          container.style.transform = ''
        })
        container.scrollTop = 0
        this.updateScrollIndicator?.()
        return
      }

      // Check for assessment section
      if (this.isCurrentSectionAssessment() && this.hasAssessment()) {
        this.renderAssessmentContent(container)
        requestAnimationFrame(() => {
          container.style.opacity = '1'
          container.style.transform = ''
        })
        if (this._pendingScrollRestore != null) {
          container.scrollTop = this._pendingScrollRestore
          this._pendingScrollRestore = null
        } else {
          container.scrollTop = 0
        }
        this.updateScrollIndicator()
        return
      }

      if (!this.currentLesson) {
        container.innerHTML = `<p>${escapeHtml(this.t('error.noLesson'))}</p>`
        container.style.opacity = '1'
        container.style.transform = ''
        return
      }

      // Lesson header (translated)
      const header = document.createElement('h2')
      header.className = 'lesson-title'
      header.textContent = this.getTranslatedLessonTitle(this.currentLesson)
      container.appendChild(header)

      // Render blocks (with translation support)
      this.currentLesson.blocks.forEach(block => {
        try {
          const element = this.renderBlock(block, { lesson: this.currentLesson })
          if (element) {
            const wrapped = this.wrapBlockInBackgroundBand(element, block)
            this.applyBlockSpacing(wrapped, block)
            container.appendChild(wrapped)
            // Observe the inner block element, not the band wrapper, so the
            // 0.5 IntersectionObserver threshold fires at the same scroll
            // position regardless of whether the block has a background —
            // the band's vertical padding would otherwise shift the trigger
            // point compared to an unbacked block of equivalent content height.
            this.observeBlock(element, block.id)
          }
        } catch (err) {
          console.error(`[Slate] Failed to render block ${block.id} (${block.type}):`, err)
        }
      })

      // Add error handlers for media elements (images, videos, audio)
      initMediaErrorHandlers(container)

      // Vertical layout: render inline navigation buttons. renderVerticalInlineNav
      // self-skips when nav chrome is hidden (single-screen course, menu off),
      // matching the footer's removal in classic layout.
      if (this.isVerticalLayout) {
        this.renderVerticalInlineNav(container)
      }

      // Fade in animation
      requestAnimationFrame(() => {
        container.style.opacity = '1'
        container.style.transform = ''
      })

      // Mark lesson as viewed and update progress
      const isFirstView = !this.viewedLessons.has(this.currentLesson.id)
      this.viewedLessons.add(this.currentLesson.id)
      this.updateProgress()
      this.saveProgress()

      // Re-render navigation to unlock next lesson
      if (this.isLockedNavigation() && isFirstView) {
        this.renderNavigation()
        this.updateNavButtons()
        if (this.isVerticalLayout) {
          this.refreshVerticalInlineNav(container)
        }
      }

      // Track lesson view via xAPI (only on first view)
      if (isFirstView && this.scorm?.trackLessonView) {
        this.scorm.trackLessonView(this.currentLesson.id, this.currentLesson.title)
      }

      // Restore scroll position on hot-reload, otherwise scroll to top
      if (this._pendingScrollRestore != null) {
        container.scrollTop = this._pendingScrollRestore
        this._pendingScrollRestore = null
      } else {
        container.scrollTop = 0
      }

      // Update scroll indicator
      this.updateScrollIndicator()

      // Apply the completion gate to the freshly-rendered lesson: ensure the
      // scroll listener is attached, set the initial gated button state, then
      // schedule a deferred reached-end check (which marks short, non-scrolling
      // lessons once their media has laid out — never synchronously).
      if (this.isRequireLessonCompletion() || this.isLessonPacing()) {
        this.setupCompletionGate()
        this.updateNavButtons()
        this.scheduleReachedEndCheck()
      }
    }, 150)
  }

  // ============================================
  // ASSESSMENT SYSTEM
  // ============================================

  renderAssessmentContent(container) {
    // Check if showing conclusion page
    if (this.showingConclusionPage && this.getConclusionLesson()) {
      this.renderConclusionPage(container)
      return
    }

    // Check if showing results from recent attempt (must be first to show scorecard after submission)
    if (this.assessmentState?.showingResults) {
      const lastAttempt = this.assessmentState.attempts[this.assessmentState.attempts.length - 1]
      const questions = this.getAssessmentQuestions()
      const correct = lastAttempt?.answers?.filter(a => a.correct).length || 0
      this.renderAssessmentResults(container, {
        correct,
        total: questions.length,
        percentage: lastAttempt?.score || 0,
        passed: lastAttempt?.passed || false
      })
      return
    }

    // Check if already passed (returning visitor who previously passed)
    if (this.hasPassedAssessment()) {
      this.renderAssessmentPassed(container)
      return
    }

    // Check if locked (no more attempts)
    if (this.isAssessmentLocked()) {
      this.renderAssessmentLocked(container)
      return
    }

    // Check if in active assessment
    if (this.isInAssessment && this.assessmentState?.currentAttempt) {
      this.renderAssessmentQuestions(container)
      return
    }

    // Show intro/start screen
    this.renderAssessmentIntro(container)
  }

  renderAssessmentIntro(container) {
    const config = this.assessmentConfig
    const questions = this.getAssessmentQuestions()
    const attemptNum = this.getCurrentAttemptNumber()
    const maxAttempts = config?.maxAttempts || 0
    const passingType = config?.passingScoreType || 'percentage'

    // Use type-specific fields with fallback to legacy passingScore for backwards compatibility
    const passingScore = passingType === 'count'
      ? (config?.passingScoreCount ?? config?.passingScore ?? 1)
      : (config?.passingScorePercentage ?? config?.passingScore ?? 70)

    const attemptsText = maxAttempts === 0
      ? this.t('assessment.unlimitedAttempts')
      : this.t('assessment.attemptCount', { current: attemptNum, max: maxAttempts })

    const passingText = passingType === 'count'
      ? `${passingScore} / ${questions.length}`
      : `${passingScore}%`

    container.innerHTML = `
      <div class="assessment-intro">
        <h2 class="assessment-intro-title">${escapeHtml(this.t('assessment.title'))}</h2>
        <p class="assessment-intro-description">
          ${escapeHtml(this.t('assessment.description'))}
        </p>
        <div class="assessment-intro-details">
          <div class="assessment-detail">
            <span class="assessment-detail-label">${escapeHtml(this.t('assessment.questions'))}</span>
            <span class="assessment-detail-value">${questions.length}</span>
          </div>
          <div class="assessment-detail">
            <span class="assessment-detail-label">${escapeHtml(this.t('assessment.passingScore'))}</span>
            <span class="assessment-detail-value">${passingText}</span>
          </div>
          <div class="assessment-detail">
            <span class="assessment-detail-label">${escapeHtml(this.t('assessment.attempts'))}</span>
            <span class="assessment-detail-value">${escapeHtml(attemptsText)}</span>
          </div>
        </div>
        <button class="assessment-start-btn" id="start-assessment">
          ${escapeHtml(this.t('assessment.start'))}
        </button>
      </div>
    `

    container.querySelector('#start-assessment').addEventListener('click', () => {
      this.startAssessment()
    })
  }

  renderAssessmentQuestions(container) {
    const questions = this.getAssessmentQuestions()
    const config = this.assessmentConfig
    const { correct, total, percentage } = this.calculateAssessmentScore()
    const answered = this.assessmentState?.currentAttempt?.answers?.length || 0

    // Build questions in order (respecting randomization)
    const orderedQuestions = this.assessmentQuestionOrder.length > 0
      ? this.assessmentQuestionOrder.map(id => questions.find(q => q.id === id)).filter(Boolean)
      : questions

    container.innerHTML = `
      <div class="assessment-questions">
        <div class="assessment-header">
          <h2 class="assessment-title">${escapeHtml(this.t('assessment.title'))}</h2>
          <div class="assessment-progress">
            ${escapeHtml(this.t('assessment.answeredCount', { answered, total }))}
          </div>
        </div>
        <div class="assessment-questions-list" id="assessment-questions-list"></div>
        <div class="assessment-footer">
          <button class="assessment-submit-btn" id="submit-assessment" ${answered < total ? 'disabled' : ''}>
            ${escapeHtml(this.t('assessment.submit'))}
          </button>
        </div>
      </div>
    `

    const questionsList = container.querySelector('#assessment-questions-list')

    // Track which questions are already answered
    const answeredIds = new Set(
      (this.assessmentState?.currentAttempt?.answers || []).map(a => a.questionId)
    )

    orderedQuestions.forEach((block, index) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'assessment-question-wrapper'
      wrapper.dataset.questionId = block.id
      wrapper.dataset.questionIndex = index

      // Determine if this question should be locked
      // It's unlocked if: it's the first question, or the previous question is answered
      const isAnswered = answeredIds.has(block.id)
      const previousBlock = orderedQuestions[index - 1]
      const previousAnswered = index === 0 || (previousBlock && answeredIds.has(previousBlock.id))
      const isLocked = !isAnswered && !previousAnswered

      if (isLocked) {
        wrapper.classList.add('question-locked')
      }
      if (isAnswered) {
        wrapper.classList.add('question-answered')
      }

      wrapper.innerHTML = `
        <div class="assessment-question-number">${escapeHtml(this.t('assessment.questionNumber', { number: index + 1 }))}</div>
        ${isLocked ? '<div class="question-locked-overlay"><span>Complete the previous question to unlock</span></div>' : ''}
      `
      const questionEl = this.renderBlock(block, { skipInit: true, lesson: this.getAssessmentBlockLesson(block.id) })
      if (questionEl) {
        wrapper.appendChild(questionEl)
        this.initAssessmentKnowledgeCheck(questionEl, block, index)
      }
      questionsList.appendChild(wrapper)
    })

    container.querySelector('#submit-assessment').addEventListener('click', () => {
      if (this.allAssessmentQuestionsAnswered()) {
        const result = this.finishAssessment()
        this.renderCurrentLesson()
      }
    })
  }

  initAssessmentKnowledgeCheck(wrapper, block, questionIndex) {
    const questionWrapper = wrapper.closest('.assessment-question-wrapper')
    const submitBtn = wrapper.querySelector('.kc-submit')
    const feedback = wrapper.querySelector('.kc-feedback')
    const isFib = block.content.questionType === 'fill-in-the-blank'

    // FIB assessment branch
    if (isFib) {
      const textInput = wrapper.querySelector('.kc-text-input')
      const correctAnswerDiv = wrapper.querySelector('.kc-correct-answer')

      // Restore existing answer
      const existingAnswer = this.assessmentState?.currentAttempt?.answers?.find(
        a => a.questionId === block.id
      )
      if (existingAnswer) {
        textInput.value = existingAnswer.textResponse || existingAnswer.selectedOptionIds[0] || ''
        textInput.readOnly = true
        const isCorrect = existingAnswer.correct
        const config = this.assessmentConfig
        if (config?.showFeedback !== false) {
          textInput.classList.add(isCorrect ? 'correct' : 'incorrect')
          feedback.textContent = isCorrect
            ? block.content.feedback.correct
            : block.content.feedback.incorrect
          feedback.className = `kc-feedback show ${isCorrect ? 'correct' : 'incorrect'}`
          if (!isCorrect && correctAnswerDiv && block.content.acceptedAnswers?.length) {
            correctAnswerDiv.textContent = this.t('quiz.correctAnswer', { answer: block.content.acceptedAnswers.join(', ') })
            correctAnswerDiv.classList.add('show')
          }
        } else {
          feedback.textContent = this.t('quiz.answerRecorded')
          feedback.className = 'kc-feedback show'
        }
        submitBtn.disabled = true
        return
      }

      if (questionWrapper?.classList.contains('question-locked')) {
        textInput.readOnly = true
        submitBtn.disabled = true
        return
      }

      submitBtn.disabled = true
      submitBtn.classList.add('assessment-question-submit')

      textInput.addEventListener('input', () => {
        if (textInput.value.trim()) {
          submitBtn.disabled = false
          submitBtn.classList.add('ready')
        } else {
          submitBtn.disabled = true
          submitBtn.classList.remove('ready')
        }
      })

      const submitFibAnswer = () => {
        const userAnswer = textInput.value.trim()
        if (!userAnswer) return

        const isCorrect = this.checkFibCorrectness(
          userAnswer,
          block.content.acceptedAnswers || [],
          block.content.caseSensitive || false
        )

        this.recordFibInteraction({
          id: block.id,
          question: block.content.question,
          userAnswer,
          acceptedAnswers: block.content.acceptedAnswers || [],
          correct: isCorrect
        })

        this.submitAssessmentAnswer(block.id, [userAnswer], isCorrect, userAnswer)
        this.completedChecks.add(block.id)

        if (this.scorm?.trackAssessmentQuestion) {
          const questions = this.getAssessmentQuestions()
          const qIdx = questions.findIndex(q => q.id === block.id)
          const assessmentSection = this.course.sections.find(s => s.isAssessment)
          this.scorm.trackAssessmentQuestion({
            blockId: block.id,
            questionText: block.content.question.replace(/<[^>]*>/g, ''),
            questionType: 'fill-in-the-blank',
            allOptions: (block.content.acceptedAnswers || []).map((a, i) => ({
              id: `accepted-${i}`, text: a, isCorrect: true
            })),
            selectedOptionIds: [userAnswer],
            isCorrect,
            questionNumber: qIdx + 1,
            totalQuestions: questions.length,
            attemptNumber: this.assessmentState?.currentAttempt?.attemptNumber || 1,
            assessmentTitle: assessmentSection?.title || 'Assessment'
          })
        }

        const config = this.assessmentConfig
        if (config?.showFeedback !== false) {
          textInput.classList.add(isCorrect ? 'correct' : 'incorrect')
          feedback.textContent = isCorrect
            ? block.content.feedback.correct
            : block.content.feedback.incorrect
          feedback.className = `kc-feedback show ${isCorrect ? 'correct' : 'incorrect'}`
          if (!isCorrect && correctAnswerDiv && block.content.acceptedAnswers?.length) {
            correctAnswerDiv.textContent = this.t('quiz.correctAnswer', { answer: block.content.acceptedAnswers.join(', ') })
            correctAnswerDiv.classList.add('show')
          }
        } else {
          feedback.textContent = this.t('quiz.answerRecorded')
          feedback.className = 'kc-feedback show'
        }

        textInput.readOnly = true
        submitBtn.disabled = true
        if (questionWrapper) questionWrapper.classList.add('question-answered')
        this.updateAssessmentSubmitButton()

        setTimeout(() => {
          this.unlockAndScrollToNextQuestion(questionIndex)
        }, 400)
      }

      submitBtn.addEventListener('click', submitFibAnswer)
      textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !submitBtn.disabled) submitFibAnswer()
      })
      return
    }

    // MC/MS assessment branch (existing)
    const options = wrapper.querySelectorAll('.kc-option')
    const isMultiSelect = block.content.questionType === 'multiple-select'
    const selectedIds = new Set()

    // Check if already answered - restore selection state and disable
    const existingAnswer = this.assessmentState?.currentAttempt?.answers?.find(
      a => a.questionId === block.id
    )
    if (existingAnswer) {
      existingAnswer.selectedOptionIds.forEach(id => {
        selectedIds.add(id)
        const selectedOpt = wrapper.querySelector(`[data-option-id="${id}"]`)
        if (selectedOpt) {
          selectedOpt.classList.add('selected')
          selectedOpt.setAttribute('aria-checked', 'true')
        }
      })
      // Already answered - disable and show feedback
      const config = this.assessmentConfig
      if (config?.showFeedback !== false) {
        this.showKcOptionFeedback(options, selectedIds, block.content.options)
        const isCorrect = this.calcKcCorrectness(selectedIds, block.content.options)
        feedback.textContent = isCorrect
          ? block.content.feedback.correct
          : block.content.feedback.incorrect
        feedback.className = `kc-feedback show ${isCorrect ? 'correct' : 'incorrect'}`
      } else {
        feedback.textContent = this.t('quiz.answerRecorded')
        feedback.className = 'kc-feedback show'
      }
      this.disableKcOptions(options, submitBtn)
      return // Already answered, no need to set up handlers
    }

    // If this question is locked, disable interaction
    if (questionWrapper?.classList.contains('question-locked')) {
      this.disableKcOptions(options, submitBtn)
      return
    }

    // Helper to submit the answer and advance
    const submitAnswer = () => {
      if (selectedIds.size === 0) return

      const isCorrect = this.calcKcCorrectness(selectedIds, block.content.options)

      // Record interaction to SCORM for question-by-question analytics
      this.recordInteraction({
        id: block.id,
        type: block.content.questionType || 'multiple-choice',
        question: block.content.question,
        options: block.content.options,
        selectedIds: [...selectedIds],
        correct: isCorrect
      })

      // Record the answer for assessment scoring
      this.submitAssessmentAnswer(block.id, [...selectedIds], isCorrect)
      this.completedChecks.add(block.id)

      // Track detailed assessment question answer via xAPI
      if (this.scorm?.trackAssessmentQuestion) {
        const questions = this.getAssessmentQuestions()
        const questionIndex = questions.findIndex(q => q.id === block.id)
        const assessmentSection = this.course.sections.find(s => s.isAssessment)
        const questionText = block.content.question.replace(/<[^>]*>/g, '')

        this.scorm.trackAssessmentQuestion({
          blockId: block.id,
          questionText: questionText,
          questionType: block.content.questionType || 'multiple-choice',
          allOptions: block.content.options.map(opt => ({
            id: opt.id,
            text: opt.text.replace(/<[^>]*>/g, ''),
            isCorrect: opt.correct === true || opt.correct === 'true'
          })),
          selectedOptionIds: Array.from(selectedIds),
          isCorrect: isCorrect,
          questionNumber: questionIndex + 1,
          totalQuestions: questions.length,
          attemptNumber: this.assessmentState?.currentAttempt?.attemptNumber || 1,
          assessmentTitle: assessmentSection?.title || 'Assessment'
        })
      }

      // Show feedback if enabled (default to true)
      const config = this.assessmentConfig
      if (config?.showFeedback !== false) {
        this.showKcOptionFeedback(options, selectedIds, block.content.options)
        feedback.textContent = isCorrect
          ? block.content.feedback.correct
          : block.content.feedback.incorrect
        feedback.className = `kc-feedback show ${isCorrect ? 'correct' : 'incorrect'}`
      } else {
        feedback.textContent = this.t('quiz.answerRecorded')
        feedback.className = 'kc-feedback show'
      }

      this.disableKcOptions(options, submitBtn)
      // Mark wrapper as answered for styling
      if (questionWrapper) {
        questionWrapper.classList.add('question-answered')
      }
      this.updateAssessmentSubmitButton()

      // Unlock and scroll to next question
      setTimeout(() => {
        this.unlockAndScrollToNextQuestion(questionIndex)
      }, 400)
    }

    // Start with submit button disabled until selection is made
    submitBtn.disabled = true
    submitBtn.classList.add('assessment-question-submit')

    // Update submit button state when options are selected
    const updateSubmitState = () => {
      if (selectedIds.size > 0) {
        submitBtn.disabled = false
        submitBtn.classList.add('ready')
      } else {
        submitBtn.disabled = true
        submitBtn.classList.remove('ready')
      }
    }

    // Use shared handlers for option selection with callback
    this.setupKcOptionHandlers(options, isMultiSelect, selectedIds, updateSubmitState)

    submitBtn.addEventListener('click', submitAnswer)
  }

  unlockAndScrollToNextQuestion(currentIndex) {
    const allWrappers = document.querySelectorAll('.assessment-question-wrapper')
    const nextIndex = currentIndex + 1

    if (nextIndex < allWrappers.length) {
      const nextWrapper = allWrappers[nextIndex]

      // Unlock the next question
      nextWrapper.classList.remove('question-locked')
      const overlay = nextWrapper.querySelector('.question-locked-overlay')
      if (overlay) {
        overlay.remove()
      }

      // Find the block data for this question
      const questionId = nextWrapper.dataset.questionId
      const questions = this.getAssessmentQuestions()
      const orderedQuestions = this.assessmentQuestionOrder.length > 0
        ? this.assessmentQuestionOrder.map(id => questions.find(q => q.id === id)).filter(Boolean)
        : questions
      const block = orderedQuestions.find(q => q.id === questionId)

      if (block) {
        // Re-render the question to get fresh DOM without disabled styles
        const questionEl = nextWrapper.querySelector('.slate-block')
        if (questionEl) {
          // Clear the old question element
          const newQuestionEl = this.renderBlock(block, { skipInit: true, lesson: this.getAssessmentBlockLesson(block.id) })
          if (newQuestionEl) {
            questionEl.replaceWith(newQuestionEl)
            // Re-initialize with event handlers now that it's unlocked
            this.initAssessmentKnowledgeCheck(newQuestionEl, block, nextIndex)
          }
        }
      }

      // Scroll to the next question (if autoscroll enabled)
      const autoScroll = this.isAssessmentAutoscroll()
      if (autoScroll) {
        nextWrapper.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      // Focus first option for keyboard users
      const firstOption = nextWrapper.querySelector('.kc-option')
      if (firstOption) firstOption.focus({ preventScroll: !autoScroll })
    } else {
      // All questions answered - scroll to submit button
      const autoScroll = this.isAssessmentAutoscroll()
      const submitBtn = document.querySelector('#submit-assessment')
      if (submitBtn) {
        if (autoScroll) {
          submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        submitBtn.focus({ preventScroll: !autoScroll })
      }
    }
  }

  updateAssessmentSubmitButton() {
    const submitBtn = document.querySelector('#submit-assessment')
    const progressEl = document.querySelector('.assessment-progress')
    const questions = this.getAssessmentQuestions()
    const answers = this.assessmentState?.currentAttempt?.answers || []
    const allAnswered = questions.length > 0 && answers.length >= questions.length

    // Update progress display
    if (progressEl) {
      progressEl.textContent = `${answers.length} of ${questions.length} answered`
    }

    // Enable submit button when all answered
    if (submitBtn && allAnswered) {
      submitBtn.disabled = false
    }
  }

  animateScoreValue(container, targetValue) {
    const scoreEl = container.querySelector('.assessment-score-value')
    if (!scoreEl || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    scoreEl.textContent = '0%'
    const duration = 800
    const startTime = performance.now()
    const animate = (now) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      scoreEl.textContent = Math.round(eased * targetValue) + '%'
      if (progress < 1) requestAnimationFrame(animate)
    }
    requestAnimationFrame(animate)
  }

  renderAssessmentResults(container, result) {
    const config = this.assessmentConfig
    const { correct, total, percentage, passed } = result
    const canRetry = this.canStartNewAttempt()

    container.innerHTML = `
      <div class="assessment-results ${passed ? 'passed' : 'failed'}">
        <div class="assessment-results-icon">
          ${passed
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
          }
        </div>
        <h2 class="assessment-results-title">${passed ? escapeHtml(this.t('assessment.congratulations')) : escapeHtml(this.t('assessment.notPassed'))}</h2>
        <p class="assessment-results-message">
          ${passed
            ? escapeHtml(this.t('assessment.successMessage'))
            : canRetry
              ? escapeHtml(this.t('assessment.failRetryMessage'))
              : escapeHtml(this.t('assessment.noAttemptsMessage'))
          }
        </p>
        <div class="assessment-results-score">
          <div class="assessment-score-circle ${passed ? 'passed' : 'failed'}">
            <span class="assessment-score-value">${percentage}%</span>
          </div>
          <div class="assessment-score-details">
            ${escapeHtml(this.t('assessment.scoreDisplay', { correct, total }))}
          </div>
        </div>
        ${canRetry && !passed ? `
          <button class="assessment-retry-btn" id="retry-assessment">
            ${escapeHtml(this.t('assessment.tryAgain'))}
          </button>
        ` : ''}
        ${passed && this.getConclusionLesson() ? `
          <button class="assessment-start-btn" id="continue-to-conclusion">
            ${escapeHtml(this.t('conclusion.continue'))}
          </button>
        ` : ''}
      </div>
    `

    if (canRetry && !passed) {
      container.querySelector('#retry-assessment').addEventListener('click', () => {
        this.retryAssessment()
      })
    }

    const continueBtn = container.querySelector('#continue-to-conclusion')
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        this.assessmentState.showingResults = false
        this.showingConclusionPage = true
        this.saveProgress()
        this.renderCurrentLesson()
        this.renderNavigation()
      })
    }

    this.animateScoreValue(container, percentage)
  }

  renderAssessmentPassed(container) {
    const lastAttempt = this.assessmentState?.attempts?.find(a => a.passed)
    const score = lastAttempt?.score || 100

    container.innerHTML = `
      <div class="assessment-results passed">
        <div class="assessment-results-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <h2 class="assessment-results-title">${escapeHtml(this.t('assessment.alreadyComplete'))}</h2>
        <p class="assessment-results-message">
          ${escapeHtml(this.t('assessment.alreadyCompleteMessage'))}
        </p>
        <div class="assessment-results-score">
          <div class="assessment-score-circle passed">
            <span class="assessment-score-value">${score}%</span>
          </div>
        </div>
        ${this.getConclusionLesson() ? `
          <button class="assessment-start-btn" id="continue-to-conclusion">
            ${escapeHtml(this.t('conclusion.continue'))}
          </button>
        ` : ''}
      </div>
    `

    const continueBtn = container.querySelector('#continue-to-conclusion')
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        this.showingConclusionPage = true
        this.saveProgress()
        this.renderCurrentLesson()
        this.renderNavigation()
      })
    }

    this.animateScoreValue(container, score)
  }

  renderAssessmentLocked(container) {
    const attempts = this.assessmentState?.attempts || []
    const bestScore = Math.max(...attempts.map(a => a.score), 0)

    container.innerHTML = `
      <div class="assessment-results failed locked">
        <div class="assessment-results-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <h2 class="assessment-results-title">${escapeHtml(this.t('assessment.lockedTitle'))}</h2>
        <p class="assessment-results-message">
          ${escapeHtml(this.t('assessment.lockedMessage'))}
        </p>
        <div class="assessment-results-score">
          <div class="assessment-score-circle failed">
            <span class="assessment-score-value">${bestScore}%</span>
          </div>
          <div class="assessment-score-details">
            ${escapeHtml(this.t('assessment.bestScore'))}
          </div>
        </div>
      </div>
    `
    this.animateScoreValue(container, bestScore)
  }

  renderConclusionPage(container) {
    const lesson = this.getConclusionLesson()
    if (!lesson) return

    // Mark conclusion as viewed and fire analytics event (first view only)
    if (!this.conclusionViewed) {
      this.conclusionViewed = true
      this.saveProgress()

      // Fire conclusion_viewed xAPI event
      if (this.scorm?.trackLessonView) {
        this.scorm.trackLessonView(lesson.id, this.getTranslatedLessonTitle(lesson))
      }
    }

    // Lesson title as h2 (same pattern as regular lessons)
    const header = document.createElement('h2')
    header.className = 'lesson-title'
    header.textContent = this.getTranslatedLessonTitle(lesson)
    container.appendChild(header)

    // Build conclusion page structure
    const wrapper = document.createElement('div')
    wrapper.className = 'conclusion-page'
    const contentDiv = document.createElement('div')
    contentDiv.className = 'conclusion-content'
    wrapper.appendChild(contentDiv)

    container.appendChild(wrapper)

    // Render blocks (with translation support, same pattern as renderCurrentLesson)
    lesson.blocks.forEach(block => {
      try {
        const element = this.renderBlock(block, { lesson })
        if (element) {
          this.applyBlockSpacing(element, block)
          contentDiv.appendChild(element)
        }
      } catch (err) {
        console.error(`[Slate] Failed to render conclusion block ${block.id} (${block.type}):`, err)
      }
    })

    // Add error handlers for media elements
    initMediaErrorHandlers(container)
  }

  renderCoverPage(container) {
    const lesson = this.getCoverLesson()
    if (!lesson) return

    const config = this.course.settings?.coverPage
    if (!config) return

    // Get translated values (course-level translation for cover settings)
    const lang = this.selectedLanguage || 'en'
    const courseTrans = this.course.translations?.[lang]
    const subtitle = courseTrans?.settings?.coverPage?.subtitle ?? config.subtitle ?? ''
    const ctaLabel = courseTrans?.settings?.coverPage?.ctaLabel ?? config.ctaLabel ?? this.t('cover.begin')

    const bg = config.background || { type: 'none', overlayOpacity: 0 }
    const layout = config.layout || 'centered'

    // Analytics: fire once per session
    if (!this._coverViewedThisSession) {
      this._coverViewedThisSession = true
      this.coverViewed = true
      this.saveProgress()
      if (this.scorm?.trackLessonView) {
        this.scorm.trackLessonView(lesson.id, this.getTranslatedLessonTitle(lesson))
      }
    }

    // Hero section
    const hero = document.createElement('section')
    // Add over-media modifier when there's an image or color bg (except minimal, which hides bg).
    // The split-image layout opts itself out of over-media text treatment via CSS —
    // its content sits on a surface panel, not over the bg.
    const hasMediaBg = (bg.type === 'image' || bg.type === 'color') && layout !== 'minimal'
    hero.className = `slate-cover slate-cover-${layout}${hasMediaBg ? ' slate-cover-over-media' : ''}`

    // Background
    const bgEl = document.createElement('div')
    bgEl.className = 'slate-cover-bg'
    if (bg.type === 'image' && bg.url) {
      // encodeURI to prevent CSS value injection via pathological URLs
      bgEl.style.backgroundImage = `url('${encodeURI(bg.url)}')`
      bgEl.style.backgroundSize = 'cover'
      bgEl.style.backgroundPosition = 'center'
    } else if (bg.type === 'color' && bg.color) {
      bgEl.style.backgroundColor = bg.color
    }
    const overlay = document.createElement('div')
    overlay.className = 'slate-cover-overlay'
    overlay.style.opacity = String((bg.overlayOpacity || 0) / 100)
    bgEl.appendChild(overlay)
    hero.appendChild(bgEl)

    // Content
    const content = document.createElement('div')
    content.className = 'slate-cover-content'

    const h1 = document.createElement('h1')
    h1.className = 'slate-cover-title'
    h1.textContent = this.getTranslatedLessonTitle(lesson)
    content.appendChild(h1)

    if (subtitle) {
      const p = document.createElement('p')
      p.className = 'slate-cover-subtitle'
      p.textContent = subtitle
      content.appendChild(p)
    }

    // Metadata row
    const meta = config.showMetadata || {}
    const metaBits = []
    if (meta.author && config.author) {
      metaBits.push(config.author)
    }
    if (meta.duration && config.duration) {
      metaBits.push(config.duration)
    }
    if (meta.lessonCount) {
      const count = this.getContentLessonCount()
      metaBits.push(this.t(count === 1 ? 'cover.lesson' : 'cover.lessons', { count }))
    }
    if (metaBits.length > 0) {
      const metaEl = document.createElement('div')
      metaEl.className = 'slate-cover-meta'
      metaBits.forEach((bit, i) => {
        if (i > 0) {
          const sep = document.createElement('span')
          sep.className = 'slate-cover-sep'
          sep.textContent = '·'
          metaEl.appendChild(sep)
        }
        const span = document.createElement('span')
        span.textContent = bit
        metaEl.appendChild(span)
      })
      content.appendChild(metaEl)
    }

    const cta = document.createElement('button')
    cta.type = 'button'
    cta.className = 'slate-cover-cta'
    cta.textContent = ctaLabel
    cta.addEventListener('click', () => this.advancePastCover())
    content.appendChild(cta)

    hero.appendChild(content)
    container.appendChild(hero)

    // Optional body blocks below hero
    if (Array.isArray(lesson.blocks) && lesson.blocks.length > 0) {
      const body = document.createElement('div')
      body.className = 'slate-cover-body'
      lesson.blocks.forEach(block => {
        try {
          const el = this.renderBlock(block, { lesson })
          if (el) {
            this.applyBlockSpacing(el, block)
            body.appendChild(el)
          }
        } catch (err) {
          console.error(`[Slate] Failed to render cover block ${block.id} (${block.type}):`, err)
        }
      })
      container.appendChild(body)
    }

    initMediaErrorHandlers(container)
  }

  advancePastCover() {
    this.coverViewed = true
    this.showingCoverPage = false
    // Walk sections to find the first content lesson's indices. Use indices
    // (not just the lesson reference) so downstream getters like
    // currentLesson/currentSection stay consistent.
    for (let sIdx = 0; sIdx < this.course.sections.length; sIdx++) {
      const section = this.course.sections[sIdx]
      for (let lIdx = 0; lIdx < section.lessons.length; lIdx++) {
        const lesson = section.lessons[lIdx]
        if (!this.isCoverLesson(lesson) && !this.isConclusionLesson(lesson)) {
          this.currentSectionIndex = sIdx
          this.currentLessonIndex = lIdx
          this.saveProgress()
          this.renderCurrentLesson()
          this.renderNavigation()
          this.updateNavButtons()
          this.updateProgress()
          return
        }
      }
    }
    // No content lessons available — keep the cover showing
    this.showingCoverPage = true
    this.saveProgress()
  }

  findFirstContentLesson() {
    for (const section of this.course.sections) {
      for (const lesson of section.lessons) {
        if (!this.isCoverLesson(lesson) && !this.isConclusionLesson(lesson)) {
          return lesson
        }
      }
    }
    return null
  }

  getContentLessonCount() {
    // Count only core content lessons: exclude cover, conclusion, and any
    // lessons inside assessment or cover sections.
    let count = 0
    for (const section of this.course.sections) {
      if (section.isAssessment || section.isCoverSection) continue
      for (const lesson of section.lessons) {
        if (this.isCoverLesson(lesson) || this.isConclusionLesson(lesson)) continue
        count++
      }
    }
    return count
  }

  // ============================================
  // BLOCK RENDERING
  // ============================================

  /**
   * If a top-level block has an image/color background, wrap its rendered
   * element in an edge-to-edge band (bg + overlay + inner content column).
   * Returns the original element unchanged when no background is set.
   * Mirrors the cover page's three-layer pattern.
   */
  wrapBlockInBackgroundBand(element, block) {
    const bg = block.background
    if (!bg || bg.type !== 'image' && bg.type !== 'color') return element

    const band = document.createElement('div')
    band.className = `slate-block-band slate-block-band-${bg.type}`

    const bgEl = document.createElement('div')
    bgEl.className = 'slate-block-band-bg'
    if (bg.type === 'image' && bg.url) {
      bgEl.style.backgroundImage = `url('${encodeURI(bg.url)}')`
      bgEl.style.backgroundSize = 'cover'
      bgEl.style.backgroundPosition = 'center'
      // Fade the image so the course page background blends through when
      // opacity is < 100. Adapts to the course theme (fades to light or
      // dark depending on what's behind). Default 100 means fully visible.
      const opacity = typeof bg.imageOpacity === 'number' ? bg.imageOpacity : 100
      if (opacity < 100) {
        bgEl.style.opacity = String(Math.max(0, opacity) / 100)
      }
    } else if (bg.type === 'color' && bg.color) {
      bgEl.style.backgroundColor = bg.color
    }

    const content = document.createElement('div')
    content.className = 'slate-block-band-content'
    content.appendChild(element)

    band.appendChild(bgEl)
    band.appendChild(content)

    // Shape dividers (top/bottom edges) — only on color bands. Each edge
    // is rendered as a full-bleed wrapper containing an evenodd-filled SVG
    // that paints the band color around the shape and leaves the shape
    // area transparent. Combined with --band-edge-top-h / --band-edge-bottom-h
    // setting an inset on the band-bg, this carves the shape OUT of the
    // band so the surface behind (page bg, theme gradient, etc.) shows
    // through naturally — theme-correct without assuming surface color.
    // Image bands are excluded because the carve can't seamlessly continue
    // an image across the band's three rendering regions.
    if (bg.type === 'color' && bg.color) {
      const addEdge = (edge, config) => {
        if (!config) return
        const isKnownShape =
          config.shape === 'fade' || !!SHAPE_DIVIDER_PATHS[config.shape]
        if (!isKnownShape) return
        const rawHeight = Number(config.height)
        const heightPx = Number.isFinite(rawHeight) ? Math.max(0, rawHeight) : 0
        if (heightPx === 0) return
        band.style.setProperty(`--band-edge-${edge}-h`, `${heightPx}px`)
        const wrapper = document.createElement('div')
        wrapper.className = `slate-block-band-edge slate-block-band-edge-${edge}`
        wrapper.innerHTML = buildShapeDividerCarveSvg(
          config.shape,
          edge,
          !!config.flipX,
          bg.color,
        )
        band.appendChild(wrapper)
      }
      addEdge('top', bg.topEdge)
      addEdge('bottom', bg.bottomEdge)
    }

    return band
  }

  /**
   * Apply per-block vertical spacing override by setting --block-vspace-scale
   * on the outermost block element. styles.css uses this variable to scale
   * margin-bottom on .slate-block and padding-block on .slate-block-band.
   * `vertical` is normalized in [-1, +1]; the resulting scale clamps to [0, 2].
   */
  applyBlockSpacing(element, block) {
    if (!element || !block || !block.spacing) return
    const v = Number(block.spacing.vertical)
    if (!Number.isFinite(v) || v === 0) return
    const clamped = Math.max(-1, Math.min(1, v))
    element.style.setProperty('--block-vspace-scale', String(1 + clamped))
  }

  renderBlock(block, options = {}) {
    const wrapper = document.createElement('div')
    const { skipInit = false, lesson = null } = options

    // Get translated content (or original if no translation)
    const content = lesson ? this.getTranslatedBlockContent(block, lesson) : block.content

    // Build className with visibility modifier
    let className = `slate-block block-${block.type}`
    const visibility = block.visibility || 'all'
    if (visibility === 'mobile-only') {
      className += ' block-mobile-only'
    } else if (visibility === 'desktop-only') {
      className += ' block-desktop-only'
    }

    // Apply custom CSS class names (sanitized)
    if (block.customClassName) {
      const sanitized = sanitizeClassName(block.customClassName)
      if (sanitized) className += ' ' + sanitized
    }

    wrapper.className = className
    wrapper.dataset.blockId = block.id
    wrapper.dataset.blockType = block.type

    switch (block.type) {
      case 'text':
        wrapper.innerHTML = sanitizeHtml(content.html)
        break

      case 'image':
        if (content.hotspots && content.hotspots.length > 0) {
          const markersHtml = content.hotspots.map((hs, i) => `
            <button class="hotspot-marker" style="left:${clampCoord(hs.x)}%;top:${clampCoord(hs.y)}%"
                    data-hotspot-index="${i}" aria-label="${escapeHtml(hs.label || this.t('a11y.hotspot', { number: i + 1 }))}" type="button">
              <span class="hotspot-marker-number">${i + 1}</span>
            </button>
          `).join('')
          wrapper.innerHTML = `
            <figure class="image-${escapeHtml(content.width) || 'large'} image-align-${escapeHtml(content.align) || 'center'}">
              <div class="hotspot-container">
                <img src="${escapeHtml(content.src)}" alt="${escapeHtml(content.alt)}" loading="lazy">
                ${markersHtml}
              </div>
              ${content.caption ? `<figcaption>${sanitizeHtml(content.caption)}</figcaption>` : ''}
            </figure>
          `
          this.initHotspotInteractions(wrapper, content.hotspots)
        } else {
          wrapper.innerHTML = `
            <figure class="image-${escapeHtml(content.width) || 'large'} image-align-${escapeHtml(content.align) || 'center'}">
              <img src="${escapeHtml(content.src)}" alt="${escapeHtml(content.alt)}" loading="lazy">
              ${content.caption ? `<figcaption>${sanitizeHtml(content.caption)}</figcaption>` : ''}
            </figure>
          `
        }
        break

      case 'video':
        wrapper.innerHTML = this.renderVideo(content, block.id)
        this.initVideoTracking(wrapper, block.id, content)
        if (content.transcript?.src) {
          this.initTranscriptPanel(wrapper, block.id)
        }
        break

      case 'divider':
        wrapper.innerHTML = `<hr class="divider-${escapeHtml(content.style) || 'line'}">`
        break

      case 'accordion':
        wrapper.innerHTML = this.renderAccordion(content)
        this.initAccordion(wrapper, content.allowMultiple, block.id, this.isRequireInteraction())
        break

      case 'tabs':
        wrapper.innerHTML = this.renderTabs(content)
        this.initTabs(wrapper, block.id, content, this.isRequireInteraction())
        break

      case 'button':
        wrapper.innerHTML = this.renderButton(content)
        this.initButtonXapi(wrapper, content, block.id)
        break

      case 'knowledge-check':
        // For knowledge-check, pass the whole block but with translated content
        wrapper.innerHTML = this.renderKnowledgeCheck({ ...block, content })
        // Skip init for assessment questions - they use initAssessmentKnowledgeCheck instead
        if (!skipInit) {
          this.initKnowledgeCheck(wrapper, { ...block, content })
        }
        break

      case 'iframe':
        wrapper.innerHTML = this.renderIframe(content)
        break

      case 'audio':
        // For audio blocks when viewing translation: hide if no translated audio (no fallback)
        if (this.isViewingTranslation && lesson?.translations?.[this.selectedLanguage]?.blocks) {
          const translatedBlock = lesson.translations[this.selectedLanguage].blocks
            .find(tb => tb.blockId === block.id)
          // If no translated content or no src in translated content, hide the block
          if (!translatedBlock?.content?.src) {
            return null
          }
        }
        wrapper.innerHTML = this.renderAudio(content)
        this.initAudioTracking(wrapper, block.id, content)
        break

      case 'document':
        wrapper.innerHTML = this.renderDocument(content, block)
        break

      case 'layout':
        wrapper.innerHTML = this.renderLayout(content)
        this.initNestedBlocks(wrapper, content.cells.flatMap(c => c.blocks))
        break

      case 'code':
        wrapper.innerHTML = this.renderCode(block.content)
        this.initCode(wrapper, block.content)
        if (block.content.blocks?.length) {
          this.initNestedBlocks(wrapper, block.content.blocks)
        }
        break

      case 'table':
        wrapper.innerHTML = this.renderTable(content)
        this.initTable(wrapper)
        break

      case 'card':
        wrapper.innerHTML = this.renderCard(content)
        this.initCard(wrapper, content)
        break

      case 'flip-card':
        wrapper.innerHTML = this.renderFlipCard(content)
        this.initFlipCard(wrapper, content, this.isRequireInteraction())
        break

      case 'card-carousel':
        wrapper.innerHTML = this.renderCardCarousel(content, block.id)
        this.initCardCarousel(wrapper, block.id, content, this.isRequireInteraction())
        break

      case 'flip-card-carousel':
        wrapper.innerHTML = this.renderFlipCardCarousel(content, block.id)
        this.initFlipCardCarousel(wrapper, block.id, content, this.isRequireInteraction())
        break

      case 'note': {
        const noteVariant = content.variant || 1
        const noteIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`
        const noteDiv = document.createElement('div')
        noteDiv.className = `note-block note-variant-${noteVariant}`
        const iconDiv = document.createElement('div')
        iconDiv.className = 'note-icon'
        iconDiv.innerHTML = noteIcon
        const contentDiv = document.createElement('div')
        contentDiv.className = 'note-content'
        contentDiv.innerHTML = sanitizeHtml(content.html || '')
        noteDiv.appendChild(iconDiv)
        noteDiv.appendChild(contentDiv)
        wrapper.appendChild(noteDiv)
        break
      }

      default:
        wrapper.innerHTML = `<p>[${escapeHtml(this.t('error.unsupportedBlock', { type: block.type }))}]</p>`
    }

    // Add narration player if block has narration for current language
    const narration = this.getBlockNarration(block, lesson)
    if (narration?.audioUrl) {
      const narrationHtml = this.renderNarrationPlayer(narration)
      const narrationDiv = document.createElement('div')
      narrationDiv.innerHTML = narrationHtml
      wrapper.appendChild(narrationDiv.firstElementChild)
      this.initNarrationPlayer(wrapper, block.id, lesson?.title)
    }

    return wrapper
  }

  /**
   * Render the narration player UI
   */
  renderNarrationPlayer(narration) {
    return `
      <div class="narration-player">
        <button class="narration-play-btn" aria-label="${escapeHtml(this.t('media.playNarration'))}">
          <svg aria-hidden="true" class="narration-play-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M8 5v14l11-7z"/>
          </svg>
          <svg aria-hidden="true" class="narration-pause-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="display:none">
            <path d="M6 4h4v16H6zm8 0h4v16h-4z"/>
          </svg>
        </button>
        <div class="narration-progress">
          <div class="narration-progress-bar"></div>
        </div>
        <span class="narration-time">0:00</span>
        <audio src="${escapeHtml(narration.audioUrl)}" preload="metadata"></audio>
      </div>
    `
  }

  /**
   * Initialize narration player interactivity
   */
  initNarrationPlayer(wrapper, blockId, lessonTitle) {
    const playerEl = wrapper.querySelector('.narration-player')
    if (!playerEl) return

    const audio = playerEl.querySelector('audio')
    const playBtn = playerEl.querySelector('.narration-play-btn')
    const playIcon = playerEl.querySelector('.narration-play-icon')
    const pauseIcon = playerEl.querySelector('.narration-pause-icon')
    const progressBar = playerEl.querySelector('.narration-progress-bar')
    const progress = playerEl.querySelector('.narration-progress')
    const timeDisplay = playerEl.querySelector('.narration-time')

    if (!audio || !playBtn) return

    // Tracking state
    const mediaTitle = `Narration: ${lessonTitle || 'Block'}`
    let hasPlayed = false
    let lastSeekTime = 0

    // Format time helper
    const formatTime = (seconds) => {
      const mins = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${mins}:${secs.toString().padStart(2, '0')}`
    }

    // Play/pause toggle
    playBtn.addEventListener('click', () => {
      if (audio.paused) {
        audio.play()
        playIcon.style.display = 'none'
        pauseIcon.style.display = 'block'
      } else {
        audio.pause()
        playIcon.style.display = 'block'
        pauseIcon.style.display = 'none'
      }
    })

    // Track play event
    audio.addEventListener('play', () => {
      if (this.scorm?.trackMediaPlay) {
        this.scorm.trackMediaPlay(blockId + '-narration', 'audio', mediaTitle, audio.currentTime, audio.duration || 0)
      }
      hasPlayed = true
    })

    // Track pause event
    audio.addEventListener('pause', () => {
      if (this.scorm?.trackMediaPause && hasPlayed && !audio.ended) {
        const progressPercent = audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0
        this.scorm.trackMediaPause(blockId + '-narration', 'audio', mediaTitle, audio.currentTime, audio.duration || 0, progressPercent)
      }
    })

    // Update progress bar
    audio.addEventListener('timeupdate', () => {
      if (audio.duration && isFinite(audio.duration)) {
        const percent = (audio.currentTime / audio.duration) * 100
        progressBar.style.width = `${percent}%`
        timeDisplay.textContent = formatTime(audio.currentTime)
      }
    })

    // Handle audio ended - track completion
    audio.addEventListener('ended', () => {
      playIcon.style.display = 'block'
      pauseIcon.style.display = 'none'
      progressBar.style.width = '0%'
      timeDisplay.textContent = '0:00'

      // Track narration completion
      if (this.scorm?.trackMediaComplete) {
        this.scorm.trackMediaComplete(blockId + '-narration', 'audio', mediaTitle, audio.duration || 0)
      }
    })

    // Track seeking
    audio.addEventListener('seeking', () => {
      lastSeekTime = audio.currentTime
    })

    audio.addEventListener('seeked', () => {
      if (this.scorm?.trackMediaSeek && hasPlayed) {
        this.scorm.trackMediaSeek(blockId + '-narration', 'audio', mediaTitle, lastSeekTime, audio.currentTime)
      }
    })

    // Click on progress bar to seek
    progress.addEventListener('click', (e) => {
      if (!audio.duration || !isFinite(audio.duration)) return
      const rect = progress.getBoundingClientRect()
      const percent = (e.clientX - rect.left) / rect.width
      lastSeekTime = audio.currentTime
      audio.currentTime = percent * audio.duration
    })
  }

  renderAudio(content) {
    const caption = content.caption ? `<figcaption>${sanitizeHtml(content.caption)}</figcaption>` : ''
    return `
      <figure class="audio-block">
        <audio src="${escapeHtml(content.src)}" controls preload="metadata"></audio>
        ${caption}
      </figure>
    `
  }

  renderDocument(content, block) {
    // Get translated content if viewing translation, falling back to source
    const translatedContent = this.getTranslatedBlockContent(block)
    const effectiveContent = translatedContent || content

    // Use translated title/description, but fall back document URL to source if not provided
    const title = escapeHtml(effectiveContent.title || effectiveContent.filename || content.filename || 'Document')
    const description = effectiveContent.description
      ? `<span class="document-description">${escapeHtml(effectiveContent.description)}</span>`
      : ''

    // Use translated document URL if provided, otherwise fall back to source
    const documentUrl = effectiveContent.src || content.src
    const filename = effectiveContent.filename || content.filename || 'document'
    const fileSize = this.formatFileSize(effectiveContent.filesize || content.filesize || 0)
    const mimeType = effectiveContent.mimeType || content.mimeType || ''

    const iconSvg = this.getDocumentIconSvg(mimeType)
    const downloadSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'

    // Subtle provider acknowledgment for documents hosted on recognised
    // third-party platforms (Google Drive, Dropbox, OneDrive, etc.). Brand
    // names are proper nouns and not localised. Renders nothing for
    // uploaded/Supabase-hosted documents — strictly additive, zero impact
    // on existing courses with non-provider URLs.
    const providerName = detectDocumentProviderName(documentUrl)
    const providerHtml = providerName
      ? `<span class="document-provider">${escapeHtml(providerName)}</span>`
      : ''
    const sizeHtml = fileSize ? `<span class="document-size">${fileSize}</span>` : ''
    const metaHtml = providerHtml || sizeHtml
      ? `<span class="document-meta">${providerHtml}${sizeHtml}</span>`
      : ''

    return `
      <div class="document-block">
        <a href="${escapeHtml(documentUrl)}"
           class="document-download"
           download="${escapeHtml(filename)}"
           target="_blank"
           rel="noopener noreferrer">
          <div class="document-icon">${iconSvg}</div>
          <div class="document-info">
            <span class="document-title">${title}</span>
            ${metaHtml}
            ${description}
          </div>
          <div class="document-action">${downloadSvg}</div>
        </a>
      </div>
    `
  }

  getDocumentIconSvg(mimeType) {
    // All document types use a simple file icon - differentiated by subtle visual cues
    // PDF icon - lines representing text
    if (mimeType.includes('pdf')) {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>'
    }
    // Spreadsheet icon - grid pattern
    if (mimeType.includes('sheet') || mimeType.includes('excel')) {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><rect x="8" y="12" width="8" height="6" rx="1"/></svg>'
    }
    // Presentation icon - circle/slide indicator
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><circle cx="10" cy="14" r="3"/></svg>'
    }
    // Word/document icon - text lines
    if (mimeType.includes('word') || mimeType.includes('document')) {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>'
    }
    // Generic file icon
    return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>'
  }

  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  renderVideo(content, blockId) {
    const captionHtml = content.caption ? `<p class="video-caption">${sanitizeHtml(content.caption)}</p>` : ''
    const captionAttr = escapeHtml(content.caption)
    const transcriptPanelHtml = content.transcript?.src
      ? this.renderTranscriptPanel(content.transcript.src, blockId)
      : ''

    if (content.provider === 'youtube') {
      const videoId = escapeHtml(this.extractYouTubeId(content.src))
      // Use a div placeholder for YouTube IFrame API tracking
      // The API will replace this div with an iframe we can control
      const playerId = `yt-player-${blockId}`
      return `
        <div class="video-wrapper">
          <div id="${playerId}"
               class="youtube-player-placeholder"
               data-video-id="${videoId}"
               data-block-id="${blockId}"
               data-caption="${captionAttr || this.t('media.youtubeVideo')}">
          </div>
        </div>
        ${captionHtml}
        ${transcriptPanelHtml}
      `
    }
    if (content.provider === 'vimeo') {
      const videoId = escapeHtml(this.extractVimeoId(content.src))
      const vimeoHash = this.extractVimeoHash(content.src)
      const vimeoParams = vimeoHash ? `?h=${escapeHtml(vimeoHash)}&dnt=1` : '?dnt=1'
      // Use iframe with Vimeo Player SDK for tracking
      const playerId = `vimeo-player-${blockId}`
      return `
        <div class="video-wrapper">
          <iframe
            id="${playerId}"
            src="https://player.vimeo.com/video/${videoId}${vimeoParams}"
            data-block-id="${blockId}"
            data-caption="${captionAttr || this.t('media.vimeoVideo')}"
            allow="autoplay; fullscreen; picture-in-picture"
            allowfullscreen
            loading="lazy"
            title="${captionAttr || this.t('media.vimeoVideo')}"
          ></iframe>
        </div>
        ${captionHtml}
        ${transcriptPanelHtml}
      `
    }
    if (content.provider === 'googledrive') {
      const fileId = escapeHtml(this.extractGoogleDriveId(content.src))
      return `
        <div class="video-wrapper">
          <iframe
            src="https://drive.google.com/file/d/${fileId}/preview"
            allow="autoplay; fullscreen"
            allowfullscreen
            loading="lazy"
            title="${captionAttr || this.t('media.googleDriveVideo')}"
          ></iframe>
        </div>
        ${captionHtml}
        ${transcriptPanelHtml}
      `
    }
    if (content.provider === 'synthesia') {
      const videoId = escapeHtml(this.extractSynthesiaId(content.src))
      return `
        <div class="video-wrapper">
          <iframe
            src="https://share.synthesia.io/embeds/videos/${videoId}"
            allow="autoplay; fullscreen"
            allowfullscreen
            loading="lazy"
            title="${captionAttr || this.t('media.synthesiaVideo')}"
          ></iframe>
        </div>
        ${captionHtml}
        ${transcriptPanelHtml}
      `
    }

    if (content.provider === 'loom') {
      const videoId = escapeHtml(this.extractLoomId(content.src))
      return `
        <div class="video-wrapper">
          <iframe
            src="https://www.loom.com/embed/${videoId}"
            allow="autoplay; fullscreen"
            allowfullscreen
            loading="lazy"
            title="${captionAttr || this.t('media.loomVideo')}"
          ></iframe>
        </div>
        ${captionHtml}
        ${transcriptPanelHtml}
      `
    }

    // Native video (url/upload) - use <track> element for subtitles
    const trackTag = content.transcript?.src
      ? `<track kind="captions" src="${escapeHtml(content.transcript.src)}" srclang="${escapeHtml(this.selectedLanguage || this.courseData?.meta?.language || 'en')}" label="Captions" default>`
      : ''

    return `
      <div class="video-wrapper">
        <video src="${escapeHtml(content.src)}" controls preload="metadata"${content.transcript?.src ? ' crossorigin="anonymous"' : ''}>${trackTag}</video>
      </div>
      ${captionHtml}
    `
  }

  // Render a collapsible transcript panel for embedded videos
  renderTranscriptPanel(transcriptSrc, blockId) {
    const panelId = `transcript-panel-${blockId}`
    return `
      <div class="video-transcript-panel" id="${panelId}" data-transcript-src="${escapeHtml(transcriptSrc)}">
        <button class="transcript-toggle" aria-expanded="false" aria-controls="${panelId}-content">
          <span class="transcript-toggle-icon">&#9654;</span>
          <span class="transcript-toggle-label">${this.t('media.showTranscript')}</span>
        </button>
        <div class="transcript-content" id="${panelId}-content" hidden>
          <div class="transcript-loading">${this.t('loading.text')}</div>
        </div>
      </div>
    `
  }

  // Initialize transcript panel toggle and lazy loading
  initTranscriptPanel(wrapper, blockId) {
    const panel = wrapper.querySelector(`#transcript-panel-${blockId}`)
    if (!panel) return

    const toggle = panel.querySelector('.transcript-toggle')
    const content = panel.querySelector('.transcript-content')
    const label = toggle?.querySelector('.transcript-toggle-label')
    if (!toggle || !content) return

    let loaded = false

    toggle.addEventListener('click', async () => {
      const isExpanded = toggle.getAttribute('aria-expanded') === 'true'

      if (!isExpanded && !loaded) {
        // First expand: fetch and parse the VTT file
        const src = panel.dataset.transcriptSrc
        if (src) {
          try {
            const response = await fetch(src)
            if (!response.ok) throw new Error('Failed to load transcript')
            const vttText = await response.text()
            const cues = this.parseVttContent(vttText)
            if (cues.length > 0) {
              content.innerHTML = this.renderTranscriptCues(cues)
            } else {
              content.innerHTML = '<p class="transcript-empty">No transcript content found.</p>'
            }
          } catch {
            content.innerHTML = '<p class="transcript-error">Could not load transcript.</p>'
          }
          loaded = true
        }
      }

      // Toggle visibility
      const newExpanded = !isExpanded
      toggle.setAttribute('aria-expanded', String(newExpanded))
      content.hidden = !newExpanded
      if (label) {
        label.textContent = newExpanded
          ? this.t('media.hideTranscript')
          : this.t('media.showTranscript')
      }
    })
  }

  // Parse VTT content into structured cues
  parseVttContent(vttText) {
    const cues = []
    const lines = vttText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    let i = 0

    // Skip WEBVTT header and any metadata
    while (i < lines.length && !lines[i].includes('-->')) {
      i++
    }

    while (i < lines.length) {
      const line = lines[i].trim()

      if (line.includes('-->')) {
        const [startStr, endStr] = line.split('-->').map(s => s.trim())
        const start = this.vttTimestampToSeconds(startStr)
        const end = this.vttTimestampToSeconds(endStr)

        // Collect cue text lines
        let text = ''
        i++
        while (i < lines.length && lines[i].trim() !== '') {
          text += (text ? ' ' : '') + lines[i].trim()
          i++
        }

        // Strip VTT formatting tags
        text = text.replace(/<[^>]+>/g, '')

        if (text) {
          cues.push({ start, end, text })
        }
      } else {
        i++
      }
    }
    return cues
  }

  // Convert VTT timestamp to seconds
  vttTimestampToSeconds(timestamp) {
    const parts = timestamp.split(':')
    if (parts.length === 3) {
      const [h, m, s] = parts
      return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)
    }
    if (parts.length === 2) {
      const [m, s] = parts
      return parseInt(m) * 60 + parseFloat(s)
    }
    return 0
  }

  // Format seconds to MM:SS display string
  formatTranscriptTime(seconds) {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // Render parsed VTT cues as HTML
  renderTranscriptCues(cues) {
    return cues.map(cue => {
      const timeStr = this.formatTranscriptTime(cue.start)
      return `<div class="transcript-cue">
        <span class="transcript-time">${timeStr}</span>
        <span class="transcript-text">${escapeHtml(cue.text)}</span>
      </div>`
    }).join('')
  }

  // Initialize video tracking for all video types (native, YouTube, Vimeo)
  initVideoTracking(wrapper, blockId, content) {
    // Check for YouTube placeholder
    const ytPlaceholder = wrapper.querySelector('.youtube-player-placeholder')
    if (ytPlaceholder && content.provider === 'youtube') {
      this.initYouTubeTracking(ytPlaceholder, blockId, content)
      return
    }

    // Check for Vimeo iframe
    const vimeoIframe = wrapper.querySelector('iframe[id^="vimeo-player-"]')
    if (vimeoIframe && content.provider === 'vimeo') {
      this.initVimeoTracking(vimeoIframe, blockId, content)
      return
    }

    // Native HTML5 video tracking
    const video = wrapper.querySelector('video')
    if (!video) return

    const mediaTitle = content.caption || 'Video'
    let hasPlayed = false
    let lastSeekTime = 0

    video.addEventListener('play', () => {
      if (this.scorm?.trackMediaPlay) {
        this.scorm.trackMediaPlay(blockId, 'video', mediaTitle, video.currentTime, video.duration)
      }
      hasPlayed = true
    })

    video.addEventListener('pause', () => {
      if (this.scorm?.trackMediaPause && hasPlayed) {
        const progress = video.duration > 0 ? (video.currentTime / video.duration) * 100 : 0
        this.scorm.trackMediaPause(blockId, 'video', mediaTitle, video.currentTime, video.duration, progress)
      }
    })

    video.addEventListener('ended', () => {
      if (this.scorm?.trackMediaComplete) {
        this.scorm.trackMediaComplete(blockId, 'video', mediaTitle, video.duration)
      }
    })

    video.addEventListener('seeked', () => {
      if (this.scorm?.trackMediaSeek && hasPlayed) {
        this.scorm.trackMediaSeek(blockId, 'video', mediaTitle, lastSeekTime, video.currentTime)
      }
      lastSeekTime = video.currentTime
    })

    video.addEventListener('seeking', () => {
      lastSeekTime = video.currentTime
    })
  }

  // Initialize video tracking for nested videos inside tab panels or accordion sections
  initNestedVideoTracking(container, contentItems) {
    if (!container) return
    const videoWrappers = container.querySelectorAll('.tab-video')
    videoWrappers.forEach(videoWrapper => {
      // Skip if already initialized
      if (videoWrapper.dataset.videoInitialized) return
      videoWrapper.dataset.videoInitialized = 'true'

      // Initialize transcript panel if present
      const transcriptPanel = videoWrapper.querySelector('.video-transcript-panel')
      if (transcriptPanel) {
        const panelBlockId = transcriptPanel.id?.replace('transcript-panel-', '')
        if (panelBlockId) {
          this.initTranscriptPanel(videoWrapper, panelBlockId)
        }
      }

      // Find the video content data from the item id
      const ytPlaceholder = videoWrapper.querySelector('.youtube-player-placeholder')
      if (ytPlaceholder) {
        const videoBlockId = ytPlaceholder.dataset.blockId
        const caption = ytPlaceholder.dataset.caption || ''
        this.initYouTubeTracking(ytPlaceholder, videoBlockId, { provider: 'youtube', caption })
        return
      }

      const vimeoIframe = videoWrapper.querySelector('iframe[id^="vimeo-player-"]')
      if (vimeoIframe) {
        const videoBlockId = vimeoIframe.dataset.blockId
        const caption = vimeoIframe.dataset.caption || ''
        this.initVimeoTracking(vimeoIframe, videoBlockId, { provider: 'vimeo', caption })
        return
      }

      const video = videoWrapper.querySelector('video')
      if (video) {
        // Use a generated id for tracking
        const videoBlockId = 'nested-video-' + Math.random().toString(36).substr(2, 9)
        this.initVideoTracking(videoWrapper, videoBlockId, { provider: 'url', caption: '' })
      }
    })
  }

  // Load YouTube IFrame API
  loadYouTubeAPI() {
    if (this.ytApiReady || this.ytApiLoading) return

    this.ytApiLoading = true

    // Set up global callback for when API loads
    window.onYouTubeIframeAPIReady = () => {
      this.ytApiReady = true
      this.ytApiLoading = false
      // Initialize all pending players
      this.ytPendingInits.forEach(init => init())
      this.ytPendingInits = []
    }

    // Load the API script
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true

    // Handle load failure (sandboxed iframes, blocked scripts, etc.)
    script.onerror = () => {
      if (this.debug) console.warn('YouTube IFrame API could not load - falling back to standard iframe')
      this.ytApiLoading = false
      // Replace placeholders with standard iframes
      this.ytPendingInits = []
      document.querySelectorAll('.youtube-player-placeholder').forEach(placeholder => {
        const videoId = placeholder.dataset.videoId
        const caption = placeholder.dataset.caption || 'YouTube video'
        const iframe = document.createElement('iframe')
        iframe.src = `https://www.youtube.com/embed/${videoId}`
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen'
        iframe.allowFullscreen = true
        iframe.title = caption
        iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;'
        placeholder.replaceWith(iframe)
      })
    }

    document.head.appendChild(script)
  }

  // Initialize YouTube player with tracking
  initYouTubeTracking(placeholder, blockId, content) {
    const videoId = placeholder.dataset.videoId
    const mediaTitle = content.caption || 'YouTube Video'
    const playerId = placeholder.id

    const createPlayer = () => {
      let hasPlayed = false
      let lastTime = 0

      // Permissions Policy container policy is sealed when the iframe document
      // loads, so the `allow` attribute MUST be set on the iframe element
      // BEFORE navigation to youtube.com. If we let `new YT.Player(divId, ...)`
      // create + navigate the iframe and then mutate `allow` in `onReady`, the
      // attribute change is too late — the document's container policy is
      // already locked in and fullscreen stays blocked inside an LMS iframe.
      //
      // To keep the YouTube IFrame API tracking working while emitting a
      // properly-permissioned iframe, we construct the iframe ourselves with
      // the correct `allow` and the `enablejsapi=1` embed URL, then attach
      // `YT.Player` to the existing iframe element rather than replacing a div.
      const placeholderEl = document.getElementById(playerId)
      if (!placeholderEl) return

      const iframe = document.createElement('iframe')
      iframe.id = playerId
      iframe.title = mediaTitle
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen'
      iframe.allowFullscreen = true
      iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;'
      const ytParams = new URLSearchParams({
        enablejsapi: '1',
        origin: window.location.origin,
        rel: '0'
      })
      iframe.src = `https://www.youtube.com/embed/${videoId}?${ytParams.toString()}`
      placeholderEl.replaceWith(iframe)

      const player = new window.YT.Player(iframe, {
        events: {
          onStateChange: (event) => {
            const currentTime = player.getCurrentTime ? player.getCurrentTime() : 0
            const duration = player.getDuration ? player.getDuration() : 0

            switch (event.data) {
              case window.YT.PlayerState.PLAYING:
                if (this.scorm?.trackMediaPlay) {
                  this.scorm.trackMediaPlay(blockId, 'video', mediaTitle, currentTime, duration)
                }
                hasPlayed = true
                break

              case window.YT.PlayerState.PAUSED:
                if (this.scorm?.trackMediaPause && hasPlayed) {
                  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
                  this.scorm.trackMediaPause(blockId, 'video', mediaTitle, currentTime, duration, progress)
                }
                break

              case window.YT.PlayerState.ENDED:
                if (this.scorm?.trackMediaComplete) {
                  this.scorm.trackMediaComplete(blockId, 'video', mediaTitle, duration)
                }
                break
            }

            // Track seeks (when time jumps significantly)
            if (hasPlayed && Math.abs(currentTime - lastTime) > 2) {
              if (this.scorm?.trackMediaSeek) {
                this.scorm.trackMediaSeek(blockId, 'video', mediaTitle, lastTime, currentTime)
              }
            }
            lastTime = currentTime
          }
        }
      })

      this.ytPlayers.set(blockId, player)
    }

    // Load API if not loaded, queue initialization
    if (!this.ytApiReady) {
      this.ytPendingInits.push(createPlayer)
      this.loadYouTubeAPI()
    } else {
      createPlayer()
    }
  }

  // Load Vimeo Player SDK
  loadVimeoAPI() {
    if (this.vimeoApiReady || this.vimeoApiLoading) return
    if (window.Vimeo && window.Vimeo.Player) {
      this.vimeoApiReady = true
      return
    }

    this.vimeoApiLoading = true

    const script = document.createElement('script')
    script.src = 'https://player.vimeo.com/api/player.js'
    script.async = true
    script.onload = () => {
      this.vimeoApiReady = true
      this.vimeoApiLoading = false
      // Initialize all pending players
      this.vimeoPendingInits.forEach(init => init())
      this.vimeoPendingInits = []
    }
    script.onerror = () => {
      if (this.debug) console.warn('Vimeo Player SDK could not load - video tracking disabled for Vimeo videos')
      this.vimeoApiLoading = false
      this.vimeoPendingInits = []
      // Vimeo iframes still work, just without tracking
    }
    document.head.appendChild(script)
  }

  // Initialize Vimeo player with tracking
  initVimeoTracking(iframe, blockId, content) {
    const mediaTitle = content.caption || 'Vimeo Video'

    const createPlayer = () => {
      let hasPlayed = false
      let lastTime = 0
      let duration = 0

      const player = new window.Vimeo.Player(iframe)
      this.vimeoPlayers.set(blockId, player)

      // Get duration
      player.getDuration().then(d => { duration = d }).catch(() => {})

      player.on('play', () => {
        player.getCurrentTime().then(currentTime => {
          if (this.scorm?.trackMediaPlay) {
            this.scorm.trackMediaPlay(blockId, 'video', mediaTitle, currentTime, duration)
          }
          hasPlayed = true
        }).catch(() => {})
      })

      player.on('pause', () => {
        if (hasPlayed) {
          player.getCurrentTime().then(currentTime => {
            if (this.scorm?.trackMediaPause) {
              const progress = duration > 0 ? (currentTime / duration) * 100 : 0
              this.scorm.trackMediaPause(blockId, 'video', mediaTitle, currentTime, duration, progress)
            }
          }).catch(() => {})
        }
      })

      player.on('ended', () => {
        if (this.scorm?.trackMediaComplete) {
          this.scorm.trackMediaComplete(blockId, 'video', mediaTitle, duration)
        }
      })

      player.on('seeked', (data) => {
        if (hasPlayed && this.scorm?.trackMediaSeek) {
          this.scorm.trackMediaSeek(blockId, 'video', mediaTitle, lastTime, data.seconds)
        }
        lastTime = data.seconds
      })

      player.on('timeupdate', (data) => {
        lastTime = data.seconds
      })
    }

    // Load API if not loaded, queue initialization
    if (!this.vimeoApiReady) {
      this.vimeoPendingInits.push(createPlayer)
      this.loadVimeoAPI()
    } else {
      createPlayer()
    }
  }

  // Initialize audio tracking for native HTML5 audio elements
  initAudioTracking(wrapper, blockId, content) {
    const audio = wrapper.querySelector('audio')
    if (!audio) return

    const mediaTitle = content.caption || 'Audio'
    let hasPlayed = false
    let lastSeekTime = 0

    audio.addEventListener('play', () => {
      if (this.scorm?.trackMediaPlay) {
        this.scorm.trackMediaPlay(blockId, 'audio', mediaTitle, audio.currentTime, audio.duration)
      }
      hasPlayed = true
    })

    audio.addEventListener('pause', () => {
      if (this.scorm?.trackMediaPause && hasPlayed) {
        const progress = audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0
        this.scorm.trackMediaPause(blockId, 'audio', mediaTitle, audio.currentTime, audio.duration, progress)
      }
    })

    audio.addEventListener('ended', () => {
      if (this.scorm?.trackMediaComplete) {
        this.scorm.trackMediaComplete(blockId, 'audio', mediaTitle, audio.duration)
      }
    })

    audio.addEventListener('seeked', () => {
      if (this.scorm?.trackMediaSeek && hasPlayed) {
        this.scorm.trackMediaSeek(blockId, 'audio', mediaTitle, lastSeekTime, audio.currentTime)
      }
      lastSeekTime = audio.currentTime
    })

    audio.addEventListener('seeking', () => {
      lastSeekTime = audio.currentTime
    })
  }

  extractYouTubeId(url) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/)
    return match ? match[1] : url
  }

  extractVimeoId(url) {
    const match = url.match(/vimeo\.com\/(\d+)/)
    return match ? match[1] : url
  }

  extractVimeoHash(url) {
    const patterns = [
      /vimeo\.com\/\d+\/([a-f0-9]+)/,
      /player\.vimeo\.com\/video\/\d+\?h=([a-f0-9]+)/,
    ]
    for (const pattern of patterns) {
      const match = url.match(pattern)
      if (match) return match[1]
    }
    return null
  }

  extractSynthesiaId(url) {
    const match = url.match(/share\.synthesia\.io\/(?:embeds\/videos\/|embed\/)?([a-f0-9-]+)/)
    if (match) return match[1]
    return url
  }

  extractLoomId(url) {
    const match = url.match(/loom\.com\/(?:share|embed)\/([a-f0-9]+)/)
    return match ? match[1] : url
  }

  extractGoogleDriveId(url) {
    const patterns = [
      /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
      /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
      /drive\.google\.com\/uc\?(?:export=download&)?id=([a-zA-Z0-9_-]+)/
    ]
    for (const pattern of patterns) {
      const match = url.match(pattern)
      if (match) return match[1]
    }
    return url
  }

  renderAccordion(content) {
    return content.items.map((item) => `
      <div class="accordion-item" data-item-id="${escapeHtml(item.id)}">
        <button class="accordion-trigger"
                id="accordion-trigger-${escapeHtml(item.id)}"
                aria-expanded="false"
                aria-controls="accordion-content-${escapeHtml(item.id)}">
          <span>${escapeHtml(item.title)}</span>
          <span class="accordion-icon" aria-hidden="true">+</span>
        </button>
        <div class="accordion-content"
             id="accordion-content-${escapeHtml(item.id)}"
             role="region"
             aria-labelledby="accordion-trigger-${escapeHtml(item.id)}">
          <div class="accordion-content-inner">${this.renderAccordionContentItems(item)}</div>
        </div>
      </div>
    `).join('')
  }

  // Render accordion content items (supports old 'body' format and new 'items' array format)
  renderAccordionContentItems(item) {
    // New format: items array with text/image content
    if (item.items && Array.isArray(item.items)) {
      return this.renderTabContentItems(item.items)
    }
    // Old format: single body string (backwards compatibility)
    if (item.body) {
      return sanitizeHtml(item.body)
    }
    return ''
  }

  renderLayout(content) {
    const { columns, rows, gap, cells, columnRatios, preset } = content

    // Gap class mapping (shared between grid and masonry)
    const gapClass = {
      'none': 'layout-gap-none',
      'sm': 'layout-gap-sm',
      'md': 'layout-gap-md',
      'lg': 'layout-gap-lg'
    }[gap] || 'layout-gap-md'

    // Masonry presets distribute cells into fixed column buckets in source
    // order. row/col/rowSpan/colSpan are ignored; columnRatios is ignored.
    // Cells are pre-bucketed in JS (not via CSS `column-count`) so an item's
    // column assignment never changes when block heights grow or shrink —
    // e.g. expanding a nested block no longer shifts later items into a
    // different column.
    if (this.isLayoutMasonryPreset(preset)) {
      const masonryCols = this.getLayoutMasonryColumns(preset)
      const columnBuckets = this.bucketMasonryCells(cells, masonryCols)
      const columnsHtml = columnBuckets.map(colCells => {
        const cellsHtml = colCells.map(cell => {
          const blocksHtml = cell.blocks
            .map(block => {
              const blockEl = this.renderBlock(block)
              return blockEl ? blockEl.outerHTML : ''
            })
            .join('')
          return `<div class="layout-cell">${blocksHtml || ''}</div>`
        }).join('')
        return `<div class="masonry-column">${cellsHtml}</div>`
      }).join('')

      return `
        <div class="layout-grid is-masonry masonry-cols-${masonryCols} ${gapClass}">
          ${columnsHtml}
        </div>
      `
    }

    // Grid presets
    const ratios = columnRatios || this.getLayoutPresetRatios(preset, columns)
    const gridTemplateColumns = ratios.map(r => `${r}fr`).join(' ')

    // Sort cells by row then column
    const sortedCells = [...cells].sort((a, b) => a.row - b.row || a.col - b.col)

    // Build cells HTML
    const cellsHtml = sortedCells.map(cell => {
      const blocksHtml = cell.blocks
        .map(block => {
          const blockEl = this.renderBlock(block)
          return blockEl ? blockEl.outerHTML : ''
        })
        .join('')

      const spanStyles = []
      if (cell.rowSpan && cell.rowSpan > 1) spanStyles.push(`grid-row: span ${cell.rowSpan}`)
      if (cell.colSpan && cell.colSpan > 1) spanStyles.push(`grid-column: span ${cell.colSpan}`)
      const styleAttr = spanStyles.length > 0 ? ` style="${spanStyles.join('; ')}"` : ''

      return `
        <div class="layout-cell"${styleAttr}>
          ${blocksHtml || ''}
        </div>
      `
    }).join('')

    return `
      <div class="layout-grid ${gapClass}" style="grid-template-columns: ${gridTemplateColumns}; grid-template-rows: repeat(${rows}, auto);">
        ${cellsHtml}
      </div>
    `
  }

  isLayoutMasonryPreset(preset) {
    return preset === 'masonry-2' || preset === 'masonry-3'
  }

  getLayoutMasonryColumns(preset) {
    if (preset === 'masonry-3') return 3
    return 2 // masonry-2 and any unknown masonry-* default
  }

  // Distribute cells into N fixed column buckets in source order so
  // DOM reading order matches authored order (col 1 then col 2 etc.)
  // and each cell's column is stable across height changes. Empty
  // trailing columns are preserved so flex alignment stays predictable.
  bucketMasonryCells(cells, columnCount) {
    const buckets = Array.from({ length: columnCount }, () => [])
    if (!cells || cells.length === 0) return buckets
    const perCol = Math.ceil(cells.length / columnCount)
    cells.forEach((cell, i) => {
      const colIdx = Math.min(Math.floor(i / perCol), columnCount - 1)
      buckets[colIdx].push(cell)
    })
    return buckets
  }

  getLayoutPresetRatios(preset, columns) {
    const presetRatios = {
      '2-col-equal': [1, 1],
      '2-col-left': [2, 1],
      '2-col-right': [1, 2],
      '3-col-equal': [1, 1, 1],
      '4-col-equal': [1, 1, 1, 1],
      '2x2': [1, 1],
      'custom': null
    }
    return presetRatios[preset] || Array(columns).fill(1)
  }

  /**
   * Render a table block
   */
  renderTable(content) {
    const { rows, headerRow, headerColumn, borderStyle, striping, caption } = content

    // Build CSS classes for table styling
    const tableClasses = [
      'slate-table',
      `table-border-${borderStyle}`,
      striping !== 'none' ? `table-stripe-${striping}` : ''
    ].filter(Boolean).join(' ')

    // Determine if we need thead/tbody separation
    const hasHeaderRow = headerRow && rows.length > 0
    const headerRows = hasHeaderRow ? [rows[0]] : []
    const bodyRows = hasHeaderRow ? rows.slice(1) : rows

    // Render function for a single row
    const renderRow = (row, rowIndex, isInHeader) => {
      const cells = row.cells.map((cell, colIndex) => {
        const isHeaderCell = isInHeader || (headerColumn && colIndex === 0)
        const tag = isHeaderCell ? 'th' : 'td'
        const scope = isInHeader ? 'col' : (headerColumn && colIndex === 0 ? 'row' : '')
        const scopeAttr = scope ? ` scope="${scope}"` : ''
        const alignStyle = cell.align && cell.align !== 'left' ? ` style="text-align:${cell.align}"` : ''

        return `<${tag}${scopeAttr}${alignStyle}>${sanitizeHtml(cell.html)}</${tag}>`
      }).join('')

      return `<tr>${cells}</tr>`
    }

    // Build HTML - use div wrapper (no figure needed since caption is inside table)
    let html = '<div class="block-table">'

    // Add aria-label when no caption for accessibility (WCAG 2.4.4)
    const ariaLabel = !caption ? ` aria-label="${escapeHtml(this.t('a11y.dataTable'))}"` : ''
    html += `<div class="table-wrapper"><table class="${tableClasses}"${ariaLabel}>`

    // Caption as first child of table for accessibility (WCAG 1.3.1)
    if (caption) {
      html += `<caption>${escapeHtml(caption)}</caption>`
    }

    // Thead
    if (headerRows.length > 0) {
      html += '<thead>'
      headerRows.forEach((row, idx) => {
        html += renderRow(row, idx, true)
      })
      html += '</thead>'
    }

    // Tbody
    if (bodyRows.length > 0) {
      html += '<tbody>'
      bodyRows.forEach((row, idx) => {
        html += renderRow(row, idx, false)
      })
      html += '</tbody>'
    }

    html += '</table></div>'

    html += '</div>'

    return html
  }

  /**
   * Initialize table scroll indicator for mobile
   */
  initTable(wrapper) {
    const tableWrapper = wrapper.querySelector('.table-wrapper')
    const table = tableWrapper?.querySelector('table')

    if (!tableWrapper || !table) return

    // Check if table overflows and add indicator class
    const checkOverflow = () => {
      const hasOverflow = table.scrollWidth > tableWrapper.clientWidth
      const atEnd = tableWrapper.scrollLeft + tableWrapper.clientWidth >= table.scrollWidth - 10
      tableWrapper.classList.toggle('has-overflow', hasOverflow && !atEnd)
    }

    // Initial check
    checkOverflow()

    // Update on scroll (hide indicator when scrolled to end)
    tableWrapper.addEventListener('scroll', checkOverflow)

    // Update on resize - register cleanup to prevent memory leak
    window.addEventListener('resize', checkOverflow)
    this.registerCleanup(() => window.removeEventListener('resize', checkOverflow))
  }

  // ==========================================================================
  // CARD BLOCKS
  // ==========================================================================

  /**
   * Render a Card block
   */
  renderCard(content) {
    const styleClass = `card-style-${escapeHtml(content.style || 'default')}`
    const imagePosition = content.imagePosition || 'top'
    const hasImage = content.imageUrl && imagePosition !== 'none'
    const layoutClass = hasImage ? `card-layout-${escapeHtml(imagePosition)}` : 'card-layout-none'
    const isClickable = content.linkUrl ? 'card-clickable' : ''

    // Render card image if present
    const imageHtml = hasImage ? `
      <div class="card-image">
        <img src="${escapeHtml(content.imageUrl)}" alt="${escapeHtml(content.imageAlt || '')}" loading="lazy"${focalPointStyle(content.imageFocalPoint)}>
      </div>
    ` : ''

    // Render card content items (text/images)
    const contentHtml = this.renderTabContentItems(content.items || [])

    // Build the inner card structure
    const cardInner = `
      ${imagePosition === 'left' ? imageHtml : ''}
      <div class="card-body">
        ${content.title ? `<h3 class="card-title">${escapeHtml(content.title)}</h3>` : ''}
        ${content.subtitle ? `<p class="card-subtitle">${escapeHtml(content.subtitle)}</p>` : ''}
        ${contentHtml ? `<div class="card-content">${contentHtml}</div>` : ''}
      </div>
      ${imagePosition === 'right' ? imageHtml : ''}
    `

    // Wrap in link if URL provided
    if (content.linkUrl) {
      const target = content.linkNewTab ? 'target="_blank" rel="noopener noreferrer"' : ''
      return `
        <a href="${sanitizeUrl(content.linkUrl)}" ${target} class="card ${styleClass} ${layoutClass} ${isClickable}">
          ${imagePosition === 'top' ? imageHtml : ''}
          <div class="card-inner">${cardInner}</div>
        </a>
      `
    }

    return `
      <div class="card ${styleClass} ${layoutClass}">
        ${imagePosition === 'top' ? imageHtml : ''}
        <div class="card-inner">${cardInner}</div>
      </div>
    `
  }

  /**
   * Initialize Card block (click tracking, etc.)
   */
  initCard(wrapper, content) {
    // xAPI tracking could be added here for card link clicks
  }

  /**
   * Render a Flip Card block
   */
  renderFlipCard(content) {
    const direction = content.flipDirection || 'horizontal'
    const trigger = content.flipTrigger || 'click'
    const aspectRatio = content.aspectRatio || '4:3'

    const renderSide = (side, className) => {
      if (!side) return `<div class="flip-card-face ${className} card-style-default"><div class="flip-card-body"></div></div>`
      const styleClass = `card-style-${escapeHtml(side.style || 'default')}`
      const info = resolveFlipCardSideImageOnly(side)

      if (info.imageOnly) {
        return `
          <div class="flip-card-face ${className} ${styleClass} flip-card-face-image-only">
            <div class="flip-card-image">
              <img src="${escapeHtml(info.imageUrl)}" alt="${escapeHtml(info.imageAlt)}" loading="lazy"${focalPointStyle(side.imageFocalPoint)}>
            </div>
          </div>
        `
      }

      return `
        <div class="flip-card-face ${className} ${styleClass}">
          ${side.imageUrl ? `
            <div class="flip-card-image">
              <img src="${escapeHtml(side.imageUrl)}" alt="${escapeHtml(side.imageAlt || '')}" loading="lazy"${focalPointStyle(side.imageFocalPoint)}>
            </div>
          ` : ''}
          <div class="flip-card-body">
            ${side.title ? `<h3 class="card-title">${escapeHtml(side.title)}</h3>` : ''}
            ${side.subtitle ? `<p class="card-subtitle">${escapeHtml(side.subtitle)}</p>` : ''}
            ${this.renderTabContentItems(side.items || [])}
          </div>
        </div>
      `
    }

    return `
      <div class="flip-card flip-${direction} flip-trigger-${trigger} aspect-${aspectRatio.replace(':', '-')}"
           role="button"
           tabindex="0"
           aria-label="${escapeHtml(this.t('a11y.flipCardHint'))}">
        <div class="flip-card-inner">
          ${renderSide(content.front, 'flip-card-front')}
          ${renderSide(content.back, 'flip-card-back')}
        </div>
        <div class="flip-card-hint">${escapeHtml(this.t('a11y.flipHint'))}</div>
      </div>
    `
  }

  /**
   * Re-initialize interactive blocks after innerHTML injection (e.g. inside layouts).
   * When container blocks convert nested blocks to HTML strings via .outerHTML,
   * event listeners are lost. This method re-attaches them.
   */
  initNestedBlocks(wrapper, blocks) {
    blocks.forEach(block => {
      const el = wrapper.querySelector(`[data-block-id="${block.id}"]`)
      if (!el) return

      switch (block.type) {
        case 'flip-card':
          this.initFlipCard(el, block.content)
          break
        case 'card-carousel':
          this.initCardCarousel(el, block.id, block.content)
          break
        case 'flip-card-carousel':
          this.initFlipCardCarousel(el, block.id, block.content)
          break
        case 'video':
          this.initVideoTracking(el, block.id, block.content)
          if (block.content.transcript?.src) {
            this.initTranscriptPanel(el, block.id)
          }
          break
        case 'audio':
          this.initAudioTracking(el, block.id, block.content)
          break
        case 'table':
          this.initTable(el)
          break
        case 'accordion':
          this.initAccordion(el, block.content.allowMultiple, block.id)
          break
        case 'tabs':
          this.initTabs(el, block.id, block.content)
          break
        case 'code':
          this.initCode(el, block.content)
          break
      }
    })
  }

  /**
   * Initialize Flip Card block (flip interactions)
   */
  initFlipCard(wrapper, content, gateTrack = false) {
    const card = wrapper.querySelector('.flip-card')
    if (!card) return

    const trigger = content.flipTrigger || 'click'

    // Interaction gate: a single flip (revealing the back) satisfies this card.
    const gateBlockId = gateTrack ? wrapper.dataset.blockId : null
    if (gateBlockId) this.registerBlockInteraction(gateBlockId, 1)

    const toggleFlip = () => {
      card.classList.toggle('flipped')
      if (gateBlockId) this.recordBlockInteraction(gateBlockId, 'flipped')
      // Update hint text
      const hint = card.querySelector('.flip-card-hint')
      if (hint) {
        hint.textContent = card.classList.contains('flipped') ? this.t('a11y.flipHintBack') : this.t('a11y.flipHint')
      }
    }

    if (trigger === 'click') {
      card.addEventListener('click', toggleFlip)
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleFlip()
        }
      })
    } else if (trigger === 'hover') {
      card.addEventListener('mouseenter', () => {
        card.classList.add('flipped')
        if (gateBlockId) this.recordBlockInteraction(gateBlockId, 'flipped')
      })
      card.addEventListener('mouseleave', () => card.classList.remove('flipped'))
      // Still allow click for touch devices
      card.addEventListener('click', toggleFlip)
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleFlip()
        }
      })
    }

    // Detect content overflow and add indicator class
    const checkOverflow = () => {
      const faces = wrapper.querySelectorAll('.flip-card-face')
      faces.forEach(face => {
        const body = face.querySelector('.flip-card-body')
        if (body && body.scrollHeight > body.clientHeight) {
          face.classList.add('has-overflow')
        } else {
          face.classList.remove('has-overflow')
        }
      })
    }

    checkOverflow()
    let resizeTimer
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(checkOverflow, 100)
    })
  }

  /**
   * Initialize hotspot marker interactions on an image
   */
  initHotspotInteractions(wrapper, hotspots) {
    const container = wrapper.querySelector('.hotspot-container')
    if (!container) return

    let activePopover = null
    let activeMarker = null

    // Document-level handler — added/removed with popover lifecycle to prevent memory leaks
    const closeOnOutsideClick = (e) => {
      if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.hotspot-marker')) {
        closePopover()
      }
    }

    const closePopover = () => {
      if (activePopover) {
        activePopover.remove()
        activePopover = null
      }
      // Remove mobile backdrop if present
      const backdrop = container.querySelector('.hotspot-backdrop')
      if (backdrop) backdrop.remove()
      if (activeMarker) {
        activeMarker.classList.remove('active')
        activeMarker = null
      }
      document.removeEventListener('click', closeOnOutsideClick)
    }

    const openPopover = (marker, hotspot) => {
      closePopover()
      activeMarker = marker
      marker.classList.add('active')

      const popover = document.createElement('div')
      popover.className = 'hotspot-popover'
      popover.setAttribute('role', 'dialog')
      popover.setAttribute('aria-label', hotspot.label)

      const titleId = 'hs-title-' + Math.random().toString(36).slice(2, 8)
      popover.setAttribute('aria-labelledby', titleId)

      popover.innerHTML = `
        <div class="hotspot-popover-header">
          <h4 class="hotspot-popover-title" id="${titleId}">${escapeHtml(hotspot.label)}</h4>
          <button class="hotspot-popover-close" aria-label="${escapeHtml(this.t('hotspot.close'))}" type="button">&times;</button>
        </div>
        ${hotspot.description ? `<div class="hotspot-popover-body">${sanitizeHtml(hotspot.description)}</div>` : ''}
      `

      container.appendChild(popover)
      activePopover = popover

      // Position the popover relative to the marker
      const containerRect = container.getBoundingClientRect()
      const markerRect = marker.getBoundingClientRect()
      const popoverRect = popover.getBoundingClientRect()

      const isMobile = window.innerWidth < 640

      if (isMobile) {
        // On mobile, center the popover as a modal overlay with separate backdrop
        const backdrop = document.createElement('div')
        backdrop.className = 'hotspot-backdrop'
        container.appendChild(backdrop)
        popover.classList.add('hotspot-popover-mobile')
      } else {
        // Constrain popover width to container if needed
        const maxWidth = containerRect.width - 16
        if (popoverRect.width > maxWidth) {
          popover.style.maxWidth = maxWidth + 'px'
        }

        // Desktop: position near the marker
        const markerCenterX = markerRect.left - containerRect.left + markerRect.width / 2
        const markerTopY = markerRect.top - containerRect.top
        const finalPopoverWidth = Math.min(popoverRect.width, maxWidth)

        // Try to place above the marker
        let top = markerTopY - popoverRect.height - 12
        let placedBelow = false
        if (top < 0) {
          // Not enough room above, place below
          top = markerTopY + markerRect.height + 12
          placedBelow = true
        }

        // Horizontal: center on marker, but clamp to container
        let left = markerCenterX - finalPopoverWidth / 2
        left = Math.max(8, Math.min(left, containerRect.width - finalPopoverWidth - 8))

        popover.style.top = top + 'px'
        popover.style.left = left + 'px'
        popover.classList.add(placedBelow ? 'hotspot-popover-below' : 'hotspot-popover-above')
      }

      // Close button handler
      popover.querySelector('.hotspot-popover-close').addEventListener('click', (e) => {
        e.stopPropagation()
        closePopover()
        marker.focus()
      })

      // Focus the popover for accessibility
      popover.setAttribute('tabindex', '-1')
      popover.focus({ preventScroll: true })

      // Escape to close
      popover.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closePopover()
          marker.focus()
        }
      })

      // Add outside-click listener (removed when popover closes)
      document.addEventListener('click', closeOnOutsideClick)
    }

    // Attach click + keyboard handlers to each marker
    const markers = wrapper.querySelectorAll('.hotspot-marker')
    markers.forEach((marker) => {
      const index = parseInt(marker.dataset.hotspotIndex, 10)
      const hotspot = hotspots[index]
      if (!hotspot) return

      const handleActivate = (e) => {
        e.stopPropagation()
        if (activeMarker === marker) {
          closePopover()
        } else {
          openPopover(marker, hotspot)
        }
      }

      marker.addEventListener('click', handleActivate)
      marker.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleActivate(e)
        }
      })
    })

    // Clean up document-level listener if popover is open when navigating away
    this.registerCleanup(() => closePopover())
  }

  /**
   * Render a Card Carousel block
   */
  renderCardCarousel(content, blockId) {
    const styleClass = `card-style-${escapeHtml(content.style || 'default')}`
    const cardsPerView = content.cardsPerView || 3

    const cardsHtml = (content.cards || []).map((card, index) => {
      const hasImage = card.imageUrl
      const isClickable = card.linkUrl ? 'card-clickable' : ''

      const cardContent = `
        ${hasImage ? `
          <div class="carousel-card-image">
            <img src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.imageAlt || '')}" loading="lazy"${focalPointStyle(card.imageFocalPoint)}>
          </div>
        ` : ''}
        <div class="carousel-card-body">
          ${card.title ? `<h4 class="card-title">${escapeHtml(card.title)}</h4>` : ''}
          ${card.subtitle ? `<p class="card-subtitle">${escapeHtml(card.subtitle)}</p>` : ''}
          ${this.renderTabContentItems(card.items || [])}
        </div>
      `

      if (card.linkUrl) {
        const target = card.linkNewTab ? 'target="_blank" rel="noopener noreferrer"' : ''
        return `
          <a href="${sanitizeUrl(card.linkUrl)}" ${target}
             class="carousel-card ${styleClass} ${isClickable}"
             data-index="${index}">
            ${cardContent}
          </a>
        `
      }

      return `
        <div class="carousel-card ${styleClass}" data-index="${index}">
          ${cardContent}
        </div>
      `
    }).join('')

    const navigationHtml = content.showNavigation ? `
      <button class="carousel-nav carousel-prev" aria-label="${escapeHtml(this.t('a11y.carouselPrev'))}">
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 18l-6-6 6-6"/>
        </svg>
      </button>
      <button class="carousel-nav carousel-next" aria-label="${escapeHtml(this.t('a11y.carouselNext'))}">
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18l6-6-6-6"/>
        </svg>
      </button>
    ` : ''

    // Dots are generated dynamically by JS based on viewport width
    // Just render an empty container if dots are enabled
    const dotsHtml = content.showDots ? `
      <div class="carousel-dots" role="tablist"></div>
    ` : ''

    return `
      <div class="card-carousel" data-cards-per-view="${cardsPerView}" data-autoplay="${content.autoplay}" data-interval="${content.autoplayInterval || 5000}" data-loop="${content.loop}">
        <div class="carousel-viewport">
          <div class="carousel-track">
            ${cardsHtml}
          </div>
        </div>
        ${navigationHtml}
        ${dotsHtml}
      </div>
    `
  }

  /**
   * Initialize Card Carousel block
   */
  initCardCarousel(wrapper, blockId, content, gateTrack = false) {
    const carousel = wrapper.querySelector('.card-carousel')
    if (!carousel) return

    // Interaction gate: satisfied once the learner reaches the last slide
    // (recorded in updateCarousel below). A carousel that fits without
    // navigation auto-satisfies on the initial updateCarousel call.
    const gateBlockId = gateTrack ? blockId : null
    if (gateBlockId) this.registerBlockInteraction(gateBlockId, 1)

    const track = carousel.querySelector('.carousel-track')
    const cards = Array.from(track.querySelectorAll('.carousel-card'))
    const prevBtn = carousel.querySelector('.carousel-prev')
    const nextBtn = carousel.querySelector('.carousel-next')
    const dotsContainer = carousel.querySelector('.carousel-dots')

    const configuredCardsPerView = parseInt(carousel.dataset.cardsPerView) || 3
    const autoplay = carousel.dataset.autoplay === 'true'
    const interval = parseInt(carousel.dataset.interval) || 5000
    const loop = carousel.dataset.loop === 'true'

    let currentIndex = 0
    let autoplayTimer = null

    // Calculate effective cards per view based on viewport width (matches CSS breakpoints)
    const getEffectiveCardsPerView = () => {
      const viewportWidth = window.innerWidth
      if (viewportWidth <= 480) return 1
      if (viewportWidth <= 768 && configuredCardsPerView >= 3) return 2
      return configuredCardsPerView
    }

    const getTotalSlides = () => {
      const effectiveCardsPerView = getEffectiveCardsPerView()
      return Math.max(1, cards.length - effectiveCardsPerView + 1)
    }

    // Show/hide navigation arrows based on whether scrolling is needed
    const updateNavVisibility = () => {
      const totalSlides = getTotalSlides()
      const needsNav = totalSlides > 1

      // If no nav buttons exist (showNavigation: false), always hide nav padding
      const hasNavButtons = prevBtn && nextBtn
      const showNav = hasNavButtons && needsNav

      if (prevBtn) prevBtn.style.display = showNav ? '' : 'none'
      if (nextBtn) nextBtn.style.display = showNav ? '' : 'none'

      // Toggle class for CSS padding adjustment
      carousel.classList.toggle('no-nav', !showNav)
    }

    // Regenerate dots based on current viewport
    const updateDots = () => {
      if (!dotsContainer) return

      const totalSlides = getTotalSlides()

      // Clear existing dots
      dotsContainer.innerHTML = ''

      // Only show dots if more than 1 slide
      if (totalSlides <= 1) return

      // Create new dots
      for (let i = 0; i < totalSlides; i++) {
        const dot = document.createElement('button')
        dot.className = `carousel-dot ${i === currentIndex ? 'active' : ''}`
        dot.setAttribute('role', 'tab')
        dot.setAttribute('aria-selected', i === currentIndex)
        dot.setAttribute('aria-label', this.t('a11y.goToSlide', { number: i + 1 }))
        dot.setAttribute('data-index', i)
        dot.addEventListener('click', () => goToSlide(i))
        dotsContainer.appendChild(dot)
      }
    }

    const updateCarousel = () => {
      const totalSlides = getTotalSlides()

      // Clamp currentIndex to valid range
      if (currentIndex >= totalSlides) {
        currentIndex = Math.max(0, totalSlides - 1)
      }

      // Calculate offset based on card width
      const cardWidth = cards[0]?.offsetWidth || 0
      const gap = 16 // CSS gap value
      const offset = currentIndex * (cardWidth + gap)
      track.style.transform = `translateX(-${offset}px)`

      // Update dots active state
      const dots = Array.from(dotsContainer?.querySelectorAll('.carousel-dot') || [])
      dots.forEach((dot, idx) => {
        const isActive = idx === currentIndex
        dot.classList.toggle('active', isActive)
        dot.setAttribute('aria-selected', isActive)
      })

      // Update button states
      if (!loop) {
        if (prevBtn) prevBtn.disabled = currentIndex === 0
        if (nextBtn) nextBtn.disabled = currentIndex >= totalSlides - 1
      }

      // Interaction gate: reaching the last slide (or a carousel that needs no
      // navigation) marks this block explored.
      if (gateBlockId && currentIndex >= totalSlides - 1) {
        this.recordBlockInteraction(gateBlockId, 'end')
      }
    }

    const goToSlide = (index) => {
      const totalSlides = getTotalSlides()
      if (loop) {
        currentIndex = ((index % totalSlides) + totalSlides) % totalSlides
      } else {
        currentIndex = Math.max(0, Math.min(index, totalSlides - 1))
      }
      updateCarousel()
    }

    const nextSlide = () => goToSlide(currentIndex + 1)
    const prevSlide = () => goToSlide(currentIndex - 1)

    // Navigation buttons
    if (prevBtn) prevBtn.addEventListener('click', prevSlide)
    if (nextBtn) nextBtn.addEventListener('click', nextSlide)

    // Autoplay — but never for users who asked for reduced motion (WCAG 2.2.2)
    const totalSlides = getTotalSlides()
    const prefersReducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (autoplay && totalSlides > 1 && !prefersReducedMotion) {
      const startAutoplay = () => {
        if (autoplayTimer) return
        autoplayTimer = setInterval(nextSlide, interval)
      }
      const stopAutoplay = () => {
        if (autoplayTimer) { clearInterval(autoplayTimer); autoplayTimer = null }
      }

      startAutoplay()

      // Pause on hover (mouse) AND on focus (keyboard) so the rotation can be
      // stopped with any input modality — WCAG 2.2.2 Pause, Stop, Hide.
      let resumeTimer = null
      let pointerInside = false
      let focusInside = false
      const pauseAutoplay = () => {
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
        stopAutoplay()
      }
      const scheduleResume = () => {
        if (pointerInside || focusInside) return
        if (resumeTimer) clearTimeout(resumeTimer)
        resumeTimer = setTimeout(() => {
          resumeTimer = null
          if (!pointerInside && !focusInside) startAutoplay()
        }, 800)
      }
      carousel.addEventListener('mouseenter', () => {
        pointerInside = true
        pauseAutoplay()
      })
      carousel.addEventListener('mouseleave', () => {
        pointerInside = false
        scheduleResume()
      })
      carousel.addEventListener('focusin', () => {
        focusInside = true
        pauseAutoplay()
      })
      carousel.addEventListener('focusout', (e) => {
        // Only resume once focus has actually left the carousel subtree.
        if (!carousel.contains(e.relatedTarget)) {
          focusInside = false
          scheduleResume()
        }
      })
    }

    // Touch/swipe support
    let touchStartX = 0
    let touchEndX = 0

    carousel.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX
    }, { passive: true })

    carousel.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX
      const diff = touchStartX - touchEndX
      if (Math.abs(diff) > 50) {
        if (diff > 0) nextSlide()
        else prevSlide()
      }
    }, { passive: true })

    // Keyboard navigation
    carousel.setAttribute('tabindex', '0')
    carousel.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') prevSlide()
      else if (e.key === 'ArrowRight') nextSlide()
    })

    // Initial setup
    updateNavVisibility()
    updateDots()
    updateCarousel()

    // Update on resize (debounced) - register cleanup to prevent memory leak
    let resizeTimer = null
    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        updateNavVisibility()
        updateDots()
        updateCarousel()
      }, 100)
    }
    window.addEventListener('resize', handleResize)
    this.registerCleanup(() => {
      window.removeEventListener('resize', handleResize)
      if (resizeTimer) clearTimeout(resizeTimer)
    })
  }

  /**
   * Render a Flip Card Carousel block — a carousel where each card has a front/back flip.
   * Composes the card-carousel DOM (track, nav, dots) with nested flip-card elements.
   */
  renderFlipCardCarousel(content) {
    const direction = content.flipDirection || 'horizontal'
    const trigger = content.flipTrigger || 'click'
    const aspectRatio = content.aspectRatio || '4:3'
    const cardsPerView = content.cardsPerView || 1

    const renderSide = (side, className) => {
      if (!side) return `<div class="flip-card-face ${className} card-style-default"><div class="flip-card-body"></div></div>`
      const styleClass = `card-style-${escapeHtml(side.style || content.style || 'default')}`
      const info = resolveFlipCardSideImageOnly(side)

      if (info.imageOnly) {
        return `
          <div class="flip-card-face ${className} ${styleClass} flip-card-face-image-only">
            <div class="flip-card-image">
              <img src="${escapeHtml(info.imageUrl)}" alt="${escapeHtml(info.imageAlt)}" loading="lazy"${focalPointStyle(side.imageFocalPoint)}>
            </div>
          </div>
        `
      }

      return `
        <div class="flip-card-face ${className} ${styleClass}">
          ${side.imageUrl ? `
            <div class="flip-card-image">
              <img src="${escapeHtml(side.imageUrl)}" alt="${escapeHtml(side.imageAlt || '')}" loading="lazy"${focalPointStyle(side.imageFocalPoint)}>
            </div>
          ` : ''}
          <div class="flip-card-body">
            ${side.title ? `<h3 class="card-title">${escapeHtml(side.title)}</h3>` : ''}
            ${side.subtitle ? `<p class="card-subtitle">${escapeHtml(side.subtitle)}</p>` : ''}
            ${this.renderTabContentItems(side.items || [])}
          </div>
        </div>
      `
    }

    const cardsHtml = (content.cards || []).map((card, index) => `
      <div class="carousel-card flip-card-carousel-card" data-index="${index}">
        <div class="flip-card flip-${direction} flip-trigger-${trigger} aspect-${aspectRatio.replace(':', '-')}"
             role="button"
             tabindex="0"
             aria-label="${escapeHtml(this.t('a11y.flipCardHint'))}">
          <div class="flip-card-inner">
            ${renderSide(card.front, 'flip-card-front')}
            ${renderSide(card.back, 'flip-card-back')}
          </div>
          <div class="flip-card-hint">${escapeHtml(this.t('a11y.flipHint'))}</div>
        </div>
      </div>
    `).join('')

    const navigationHtml = content.showNavigation ? `
      <button class="carousel-nav carousel-prev" aria-label="${escapeHtml(this.t('a11y.flipCarouselPrev'))}">
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 18l-6-6 6-6"/>
        </svg>
      </button>
      <button class="carousel-nav carousel-next" aria-label="${escapeHtml(this.t('a11y.flipCarouselNext'))}">
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18l6-6-6-6"/>
        </svg>
      </button>
    ` : ''

    const dotsHtml = content.showDots ? `
      <div class="carousel-dots" role="tablist"></div>
    ` : ''

    return `
      <div class="card-carousel flip-card-carousel" data-cards-per-view="${cardsPerView}" data-autoplay="${content.autoplay}" data-interval="${content.autoplayInterval || 5000}" data-loop="${content.loop}">
        <div class="carousel-viewport">
          <div class="carousel-track">
            ${cardsHtml}
          </div>
        </div>
        ${navigationHtml}
        ${dotsHtml}
      </div>
    `
  }

  /**
   * Initialize a Flip Card Carousel: carousel navigation + per-card flip.
   * Delegates to initCardCarousel for the carousel wiring, then attaches flip
   * handlers to each nested flip-card.
   */
  initFlipCardCarousel(wrapper, blockId, content, gateTrack = false) {
    // Carousel behavior: reuse the card-carousel implementation. Pass gateTrack
    // false so it does not register a (reach-end) target for this block — the
    // flip-card-carousel gates on flipping every card instead, registered below.
    this.initCardCarousel(wrapper, blockId, content, false)

    // Per-card flip behavior: reuse initFlipCard logic against each nested flip-card
    const flipCards = wrapper.querySelectorAll('.flip-card-carousel-card .flip-card')

    // Interaction gate: every card must be flipped at least once (the back is
    // the point of a flashcard stack). Navigation is implied — off-screen cards
    // must be brought into view to be flipped.
    const gateBlockId = gateTrack ? blockId : null
    if (gateBlockId) this.registerBlockInteraction(gateBlockId, flipCards.length)

    flipCards.forEach((card, cardIndex) => {
      const trigger = content.flipTrigger || 'click'

      const toggleFlip = (e) => {
        // Prevent the flip click from bubbling up to the carousel viewport
        // (otherwise clicking the card would also trigger carousel keyboard handlers).
        if (e) e.stopPropagation()
        card.classList.toggle('flipped')
        if (gateBlockId) this.recordBlockInteraction(gateBlockId, cardIndex)
        const hint = card.querySelector('.flip-card-hint')
        if (hint) {
          hint.textContent = card.classList.contains('flipped') ? this.t('a11y.flipHintBack') : this.t('a11y.flipHint')
        }
      }

      if (trigger === 'click') {
        card.addEventListener('click', toggleFlip)
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            toggleFlip()
          }
        })
      } else if (trigger === 'hover') {
        card.addEventListener('mouseenter', () => {
          card.classList.add('flipped')
          if (gateBlockId) this.recordBlockInteraction(gateBlockId, cardIndex)
        })
        card.addEventListener('mouseleave', () => card.classList.remove('flipped'))
        card.addEventListener('click', toggleFlip)
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            toggleFlip()
          }
        })
      }

      // Overflow indicator (same as initFlipCard)
      const checkOverflow = () => {
        card.querySelectorAll('.flip-card-face').forEach(face => {
          const body = face.querySelector('.flip-card-body')
          if (body && body.scrollHeight > body.clientHeight) {
            face.classList.add('has-overflow')
          } else {
            face.classList.remove('has-overflow')
          }
        })
      }
      checkOverflow()
    })
  }

  renderCode(content) {
    // Generate unique ID for CSS scoping
    const containerId = `code-block-${Math.random().toString(36).substr(2, 9)}`

    // HTML and Snippet modes: render custom HTML with scoped CSS
    // Snippet mode stores parsed HTML in the same fields as HTML mode
    if (content.mode === 'html' || content.mode === 'snippet') {
      const scopedCss = content.css ? this.scopeCss(content.css, `#${containerId}`) : ''
      const styleTag = scopedCss ? `<style>${scopedCss}</style>` : ''
      // Sanitize HTML with DOMPurify when available (live previews)
      // Falls back to raw HTML for offline SCORM where DOMPurify may not be loaded
      const rawHtml = content.html || ''
      const htmlContent = window.DOMPurify
        ? DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['data-*'] })
        : rawHtml

      return `<div id="${containerId}" class="code-block-container">${styleTag}${htmlContent}</div>`
    }

    // Blocks mode: render nested child blocks with optional CSS
    const scopedCss = content.css ? this.scopeCss(content.css, `#${containerId}`) : ''
    const styleTag = scopedCss ? `<style>${scopedCss}</style>` : ''

    const blocksHtml = (content.blocks || [])
      .map(block => {
        const blockEl = this.renderBlock(block)
        return blockEl ? blockEl.outerHTML : ''
      })
      .join('')

    return `<div id="${containerId}" class="code-block-container">${styleTag}${blocksHtml}</div>`
  }

  // Sanitize CSS to remove potentially dangerous patterns
  sanitizeCss(css) {
    return css
      // Block javascript: URLs in url()
      .replace(/url\s*\(\s*(['"]?)javascript:/gi, 'url($1blocked:')
      // Block @import rules (can load external resources)
      .replace(/@import\s+/gi, '/* @import blocked */ ')
      // Block IE expression() (legacy XSS vector)
      .replace(/expression\s*\(/gi, '/* expression blocked */ (')
      // Block IE behavior property (legacy XSS vector)
      .replace(/behavior\s*:/gi, '/* behavior blocked */')
      // Block </style> tag breakout (prevents escaping into HTML context)
      .replace(/<\/style/gi, '/* closing tag blocked */')
  }

  // Scope CSS rules to a container by prefixing selectors
  scopeCss(css, containerSelector) {
    // Sanitize CSS first to remove dangerous patterns
    const sanitized = this.sanitizeCss(css)
    // CSS scoping: prefix each rule with the container selector
    // This prevents user styles from leaking to the parent page
    return sanitized
      .replace(/([^\r\n,{}]+)(,(?=[^}]*{)|\s*{)/g, (match, selector, suffix) => {
        const trimmed = selector.trim()
        // Skip @rules (media, keyframes, supports, etc.)
        if (trimmed.startsWith('@')) return match
        // Skip keyframe percentages
        if (/^\s*\d+%?\s*$/.test(trimmed)) return match
        // Replace body/html selectors with container (prevents page-wide styles)
        if (trimmed === 'body' || trimmed === 'html' || trimmed === ':root') {
          return `${containerSelector}${suffix}`
        }
        // Replace selectors starting with body/html (e.g., "body .foo")
        if (/^(body|html|:root)\s+/.test(trimmed)) {
          const rest = trimmed.replace(/^(body|html|:root)\s+/, '')
          return `${containerSelector} ${rest}${suffix}`
        }
        // Prefix the selector
        return `${containerSelector} ${trimmed}${suffix}`
      })
  }

  initCode(wrapper, content) {
    const container = wrapper.querySelector('.code-block-container')
    if (!container) return

    // Apply theme variables to container (for CSS-only and JS code blocks)
    this.applyThemeToCodeBlock(container)

    // Exit early if no JS to execute
    if (!content.js || !content.js.trim()) return

    // Create a secure container proxy that blocks constructor access
    // This prevents escaping the sandbox via: container.constructor.prototype.constructor('return globalThis')()
    const createSecureProxy = (target) => {
      return new Proxy(target, {
        get(obj, prop) {
          // Block constructor access to prevent sandbox escape
          if (prop === 'constructor' || prop === '__proto__') {
            return undefined
          }
          const value = obj[prop]
          // Also block constructor access on returned objects
          if (value && typeof value === 'object' && prop !== 'style' && prop !== 'classList') {
            return createSecureProxy(value)
          }
          // For methods, bind them to the original object
          if (typeof value === 'function') {
            return value.bind(obj)
          }
          return value
        },
        set(obj, prop, value) {
          if (prop === 'constructor' || prop === '__proto__') {
            return false
          }
          obj[prop] = value
          return true
        },
        getPrototypeOf() {
          return null // Hide prototype chain
        }
      })
    }

    // Globals to shadow (pass as undefined to block access)
    // This prevents user code from accessing parent frames, global document, etc.
    const blockedGlobals = [
      'window', 'document', 'parent', 'top', 'self', 'frames',
      'globalThis', 'eval', 'Function', 'localStorage', 'sessionStorage',
      'fetch', 'XMLHttpRequest', 'WebSocket', 'postMessage',
      'Proxy', 'Reflect', 'Object', 'Array'  // Block reflection APIs that could bypass sandbox
    ]

    const executeWithoutJquery = () => {
      try {
        // Create a secure proxy wrapper for the container
        const secureContainer = createSecureProxy(container)
        // Shadow dangerous globals by passing them as undefined parameters
        const scopedFunction = new Function('container', ...blockedGlobals, content.js)
        scopedFunction(secureContainer)
      } catch (error) {
        console.error('Code block error:', error)
      }
    }

    const executeWithJquery = () => {
      try {
        if (!window.jQuery) {
          if (this.debug) console.warn('[Code Block] jQuery not available, running without it')
          executeWithoutJquery()
          return
        }
        // Create a secure proxy wrapper for the container
        const secureContainer = createSecureProxy(container)
        // Create scoped $ function that searches within the container by default
        const $ = (selector) => {
          if (typeof selector === 'string') {
            return window.jQuery(container).find(selector)
          }
          // Only allow DOM elements, not arbitrary objects that could expose prototypes
          if (selector instanceof HTMLElement) {
            return window.jQuery(selector)
          }
          return window.jQuery()
        }
        // Copy only safe static utility methods (block fn, prototype, and constructor chain access)
        const safeStaticMethods = ['each', 'map', 'grep', 'extend', 'isArray', 'isFunction', 'isPlainObject', 'trim', 'type', 'now', 'parseJSON', 'noop', 'merge', 'makeArray', 'inArray', 'proxy']
        safeStaticMethods.forEach(key => {
          if (typeof window.jQuery[key] === 'function') {
            $[key] = window.jQuery[key].bind(window.jQuery)
          }
        })

        // Shadow dangerous globals by passing them as undefined parameters
        // Pass scoped $ for both parameters — do NOT pass window.jQuery directly
        const scopedFunction = new Function('container', '$', 'jQuery', ...blockedGlobals, content.js)
        scopedFunction(secureContainer, $, $)
      } catch (error) {
        console.error('Code block error:', error)
      }
    }

    if (content.useJquery) {
      this.loadJquery()
        .then(executeWithJquery)
        .catch(err => {
          console.error('[Code Block] jQuery failed to load:', err.message)
          if (this.debug) console.warn('[Code Block] Running code without jQuery. Note: jQuery may not load in sandboxed previews.')
          executeWithoutJquery()
        })
    } else {
      executeWithoutJquery()
    }
  }

  loadJquery() {
    // Return existing promise if jQuery is already loading/loaded
    if (this.jqueryPromise) return this.jqueryPromise

    // Check if jQuery is already available
    if (window.jQuery) {
      return Promise.resolve()
    }

    // Load jQuery from CDN
    this.jqueryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://code.jquery.com/jquery-3.7.1.min.js'
      script.crossOrigin = 'anonymous'

      script.onload = () => {
        // Wait for jQuery to actually be available on window
        const checkJQuery = (attempts = 0) => {
          if (window.jQuery) {
            resolve()
          } else if (attempts < 50) {
            // Check every 10ms for up to 500ms
            setTimeout(() => checkJQuery(attempts + 1), 10)
          } else {
            reject(new Error('jQuery script loaded but jQuery not available'))
          }
        }
        checkJQuery()
      }

      script.onerror = () => {
        if (this.debug) console.warn('[Code Block] Could not load jQuery from CDN.')
        reject(new Error('Failed to load jQuery'))
      }

      document.head.appendChild(script)
    })

    return this.jqueryPromise
  }

  // ============================================
  // BLOCK INTERACTIONS
  // ============================================

  // Shared helper: set up KC option click/keyboard handlers
  // Optional onChange callback is called whenever selection changes
  setupKcOptionHandlers(options, isMultiSelect, selectedIds, onChange) {
    // Eliminated options (via eliminateWrongOptions on MC blocks) and locked
    // options both carry aria-disabled='true'; refuse selection mutations on
    // either. Keeps arrow-key navigation working but blocks Enter/Space and
    // mouse clicks from changing state.
    const isDisabled = (opt) => opt.getAttribute('aria-disabled') === 'true'

    const selectSingleOption = (opt) => {
      if (isDisabled(opt)) return
      options.forEach(o => {
        o.classList.remove('selected')
        o.setAttribute('aria-checked', 'false')
        o.setAttribute('tabindex', '-1')
      })
      opt.classList.add('selected')
      opt.setAttribute('aria-checked', 'true')
      opt.setAttribute('tabindex', '0')
      selectedIds.clear()
      selectedIds.add(opt.dataset.optionId)
      if (onChange) onChange()
    }

    const toggleMultiOption = (opt) => {
      if (isDisabled(opt)) return
      const optionId = opt.dataset.optionId
      if (selectedIds.has(optionId)) {
        selectedIds.delete(optionId)
        opt.classList.remove('selected')
        opt.setAttribute('aria-checked', 'false')
      } else {
        selectedIds.add(optionId)
        opt.classList.add('selected')
        opt.setAttribute('aria-checked', 'true')
      }
      if (onChange) onChange()
    }

    options.forEach((opt, index) => {
      opt.addEventListener('click', () => {
        if (isMultiSelect) {
          toggleMultiOption(opt)
        } else {
          selectSingleOption(opt)
        }
      })

      opt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (isMultiSelect) {
            toggleMultiOption(opt)
          } else {
            selectSingleOption(opt)
          }
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault()
          const nextIndex = (index + 1) % options.length
          options[nextIndex].focus()
          if (!isMultiSelect) {
            selectSingleOption(options[nextIndex])
          }
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault()
          const prevIndex = (index - 1 + options.length) % options.length
          options[prevIndex].focus()
          if (!isMultiSelect) {
            selectSingleOption(options[prevIndex])
          }
        }
      })
    })
  }

  // Shared helper: calculate if KC answer is correct
  calcKcCorrectness(selectedIds, blockOptions) {
    const correctIds = new Set(
      blockOptions.filter(o => o.correct === true || o.correct === 'true').map(o => o.id)
    )
    return selectedIds.size === correctIds.size &&
      [...selectedIds].every(id => correctIds.has(id))
  }

  // Shared helper: show correct/incorrect feedback on options
  showKcOptionFeedback(options, selectedIds, blockOptions) {
    options.forEach(opt => {
      const optData = blockOptions.find(o => o.id === opt.dataset.optionId)
      const wasSelected = selectedIds.has(opt.dataset.optionId)
      const isCorrectOption = optData?.correct === true || optData?.correct === 'true'

      if (isCorrectOption && wasSelected) {
        opt.classList.add('correct')
      } else if (isCorrectOption && !wasSelected) {
        opt.classList.add('correct', 'missed')
      } else if (!isCorrectOption && wasSelected) {
        opt.classList.add('incorrect')
      }
    })
  }

  // Shared helper: disable KC options after submission
  disableKcOptions(options, submitBtn) {
    options.forEach(opt => {
      opt.style.pointerEvents = 'none'
      opt.setAttribute('tabindex', '-1')
      opt.setAttribute('aria-disabled', 'true')
    })
    submitBtn.disabled = true
  }

  // Resolve effective KC config. Block override > course default > built-in.
  // FIB defaults revealCorrectAnswer to true to recover pre-v0.95.3-beta behaviour
  // for authors who set a finite maxAttempts.
  resolveKcConfig(block) {
    const courseDefaults = this.course?.settings?.knowledgeChecks
    const blockContent = block.content || {}
    const isFib = blockContent.questionType === 'fill-in-the-blank'
    const builtInRevealCorrect = isFib ? true : false
    return {
      maxAttempts: blockContent.maxAttempts ?? courseDefaults?.maxAttempts ?? 0,
      revealCorrectAnswer:
        blockContent.revealCorrectAnswer ??
        courseDefaults?.revealCorrectAnswer ??
        builtInRevealCorrect,
      revealAnswersPerAttempt:
        blockContent.revealAnswersPerAttempt ??
        courseDefaults?.revealAnswersPerAttempt ??
        true,
      showFeedback:
        blockContent.showFeedback ??
        courseDefaults?.showFeedback ??
        true,
      // MC-only at the player layer; resolved here for all question types so
      // the dialog UX can show one inherited value. The MC submit handler
      // gates on questionType before honouring it.
      eliminateWrongOptions:
        blockContent.eliminateWrongOptions ??
        courseDefaults?.eliminateWrongOptions ??
        false,
    }
  }

  initAccordion(wrapper, allowMultiple, blockId, gateTrack = false) {
    const items = wrapper.querySelectorAll('.accordion-item')

    // Interaction gate: every panel must be opened at least once.
    const gateBlockId = gateTrack ? blockId : null
    if (gateBlockId) this.registerBlockInteraction(gateBlockId, items.length)

    items.forEach((item, panelIndex) => {
      const trigger = item.querySelector('.accordion-trigger')
      const content = item.querySelector('.accordion-content')
      const inner = content.querySelector('.accordion-content-inner')
      const panelTitle = trigger.textContent.trim()

      trigger.addEventListener('click', () => {
        if (!allowMultiple) {
          items.forEach(i => {
            if (i !== item && i.classList.contains('open')) {
              i.classList.remove('open')
              i.querySelector('.accordion-trigger').setAttribute('aria-expanded', 'false')
              i.querySelector('.accordion-content').style.maxHeight = '0'
            }
          })
        }

        const isOpen = item.classList.toggle('open')
        trigger.setAttribute('aria-expanded', isOpen)

        if (isOpen && gateBlockId) this.recordBlockInteraction(gateBlockId, panelIndex)

        if (isOpen) {
          content.style.maxHeight = inner.scrollHeight + 40 + 'px'
          // Initialize video tracking for any nested videos in the opened panel
          this.initNestedVideoTracking(content)
        } else {
          content.style.maxHeight = '0'
        }

        // Track accordion interaction via xAPI
        if (this.scorm?.trackAccordionInteraction) {
          this.scorm.trackAccordionInteraction(blockId, panelIndex, panelTitle, isOpen)
        }
      })
    })
  }

  renderTabs(content) {
    const isVertical = content.orientation === 'vertical'
    const orientationClass = isVertical ? 'tabs-vertical' : 'tabs-horizontal'
    const ariaOrientation = isVertical ? 'aria-orientation="vertical"' : ''

    return `
      <div class="tabs-container ${orientationClass}">
        <div class="tabs-header-wrapper">
          <div class="tabs-header" role="tablist" aria-label="${escapeHtml(this.t('tabs.contentTabs'))}" ${ariaOrientation}>
            ${content.items.map((item, index) => `
              <button class="tab-button ${index === 0 ? 'active' : ''}"
                      id="tab-${escapeHtml(item.id)}"
                      role="tab"
                      aria-selected="${index === 0}"
                      aria-controls="tabpanel-${escapeHtml(item.id)}"
                      tabindex="${index === 0 ? '0' : '-1'}"
                      data-tab="${index}">
                ${escapeHtml(item.label)}
              </button>
            `).join('')}
          </div>
        </div>
        <div class="tabs-content">
          ${content.items.map((item, index) => `
            <div class="tab-panel ${index === 0 ? 'active' : ''}"
                 id="tabpanel-${escapeHtml(item.id)}"
                 role="tabpanel"
                 aria-labelledby="tab-${escapeHtml(item.id)}"
                 ${index !== 0 ? 'hidden' : ''}
                 data-tab="${index}">
              ${this.renderTabContentItems(item.items)}
            </div>
          `).join('')}
        </div>
      </div>
    `
  }

  renderTabContentItems(items) {
    if (!items || items.length === 0) return ''
    return items.map(item => {
      if (item.type === 'text') {
        return sanitizeHtml(item.content)
      } else if (item.type === 'image') {
        const width = escapeHtml(item.width) || 'large'
        const align = escapeHtml(item.align) || 'center'
        return `<figure class="tab-image image-${width} image-align-${align}">
          <img src="${escapeHtml(item.content)}" alt="${escapeHtml(item.alt)}" loading="lazy" />
        </figure>`
      } else if (item.type === 'video') {
        const videoContent = { src: item.content, provider: item.provider || 'url', caption: item.caption, transcript: item.transcript }
        return `<div class="tab-video">${this.renderVideo(videoContent, item.id)}</div>`
      }
      return ''
    }).join('')
  }

  initTabs(wrapper, blockId, content, gateTrack = false) {
    const buttons = wrapper.querySelectorAll('[role="tab"]')
    const panels = wrapper.querySelectorAll('[role="tabpanel"]')
    const headerWrapper = wrapper.querySelector('.tabs-header-wrapper')
    const header = wrapper.querySelector('.tabs-header')
    const isVertical = wrapper.querySelector('.tabs-container')?.classList.contains('tabs-vertical')
    let currentTabIndex = 0
    let pointerScrollPosition = null

    // Interaction gate: every tab must be viewed. Tab 0 is active on load, so it
    // counts as viewed immediately (a single-tab block thus auto-satisfies).
    const gateBlockId = gateTrack ? blockId : null
    if (gateBlockId) {
      this.registerBlockInteraction(gateBlockId, buttons.length)
      this.recordBlockInteraction(gateBlockId, 0)
    }

    // Scroll indicator logic (only for horizontal tabs)
    const updateScrollIndicators = () => {
      if (!header || !headerWrapper || isVertical) return
      const { scrollLeft, scrollWidth, clientWidth } = header
      const canScrollLeft = scrollLeft > 0
      const canScrollRight = scrollLeft < scrollWidth - clientWidth - 1

      headerWrapper.classList.toggle('can-scroll-left', canScrollLeft)
      headerWrapper.classList.toggle('can-scroll-right', canScrollRight)
    }

    // Initialize and listen for scroll
    if (header && !isVertical) {
      header.addEventListener('scroll', updateScrollIndicators, { passive: true })
      // Check initial state after render
      requestAnimationFrame(updateScrollIndicators)
      // Also check on window resize - register cleanup to prevent memory leak
      window.addEventListener('resize', updateScrollIndicators, { passive: true })
      this.registerCleanup(() => window.removeEventListener('resize', updateScrollIndicators))
    }

    const getScrollPosition = () => {
      const content = document.getElementById('player-content')
      return {
        content,
        contentTop: content?.scrollTop ?? null,
        windowX: window.scrollX || window.pageXOffset || 0,
        windowY: window.scrollY || window.pageYOffset || 0
      }
    }

    const restoreScrollPosition = (position) => {
      if (!position) return
      if (position.content && position.contentTop != null) {
        position.content.scrollTop = position.contentTop
      }
      if (typeof window.scrollTo === 'function') {
        window.scrollTo(position.windowX, position.windowY)
      }
    }

    const preserveScrollPosition = (position) => {
      if (!position) return
      restoreScrollPosition(position)
      requestAnimationFrame(() => restoreScrollPosition(position))
    }

    const switchTab = (newTab, options = {}) => {
      const { focus = true, scrollPositionToPreserve = null } = options
      const tabIndex = parseInt(newTab.dataset.tab, 10)
      const previousTabIndex = currentTabIndex

      buttons.forEach(b => {
        b.classList.remove('active')
        b.setAttribute('aria-selected', 'false')
        b.setAttribute('tabindex', '-1')
      })

      panels.forEach(p => {
        p.classList.remove('active')
        p.hidden = true
      })

      newTab.classList.add('active')
      newTab.setAttribute('aria-selected', 'true')
      newTab.setAttribute('tabindex', '0')
      // preventScroll: keep keyboard focus management (roving tabindex) without
      // yanking the viewport up to the tabs header on every tab select — that
      // scroll jump pulls the learner away from the bottom and fights the
      // completion gate's scroll-to-end check.
      if (focus) newTab.focus({ preventScroll: true })

      const panel = wrapper.querySelector(`[data-tab="${tabIndex}"][role="tabpanel"]`)
      panel.classList.add('active')
      panel.hidden = false

      // Track tab interaction via xAPI
      if (tabIndex !== previousTabIndex && this.scorm?.trackTabInteraction) {
        const tabTitle = content?.items?.[tabIndex]?.label || newTab.textContent.trim()
        this.scorm.trackTabInteraction(blockId, tabIndex, tabTitle, previousTabIndex)
      }

      // Interaction gate: mark this tab viewed.
      if (gateBlockId) this.recordBlockInteraction(gateBlockId, tabIndex)

      // Initialize video tracking for any newly-visible nested videos
      this.initNestedVideoTracking(panel, content?.items?.[tabIndex]?.items)

      currentTabIndex = tabIndex

      if (scrollPositionToPreserve) {
        preserveScrollPosition(scrollPositionToPreserve)
      }
    }

    // Guard against empty tabs (malformed data)
    if (buttons.length === 0) return

    buttons.forEach(btn => {
      const capturePointerScrollPosition = () => {
        pointerScrollPosition = getScrollPosition()
      }

      btn.addEventListener('pointerdown', capturePointerScrollPosition, { passive: true })
      btn.addEventListener('touchstart', capturePointerScrollPosition, { passive: true })
      // Suppress the browser's native focus-on-mousedown: a freshly-clicked tab
      // button (especially one that starts at tabindex="-1") would otherwise be
      // scrolled into view before the click handler can focus it with
      // preventScroll. Keyboard focus management still happens in switchTab().
      btn.addEventListener('mousedown', (e) => {
        if (!pointerScrollPosition) capturePointerScrollPosition()
        e.preventDefault()
      })

      btn.addEventListener('click', () => {
        const scrollPositionToPreserve = pointerScrollPosition
        pointerScrollPosition = null
        switchTab(btn, { focus: false, scrollPositionToPreserve })
      })

      btn.addEventListener('keydown', (e) => {
        const index = Array.from(buttons).indexOf(btn)
        let newIndex

        // For vertical tabs, use Up/Down arrows; for horizontal, use Left/Right
        const nextKey = isVertical ? 'ArrowDown' : 'ArrowRight'
        const prevKey = isVertical ? 'ArrowUp' : 'ArrowLeft'

        if (e.key === nextKey) {
          newIndex = (index + 1) % buttons.length
          e.preventDefault()
        } else if (e.key === prevKey) {
          newIndex = (index - 1 + buttons.length) % buttons.length
          e.preventDefault()
        } else if (e.key === 'Home') {
          newIndex = 0
          e.preventDefault()
        } else if (e.key === 'End') {
          newIndex = buttons.length - 1
          e.preventDefault()
        }

        if (newIndex !== undefined) {
          switchTab(buttons[newIndex], { focus: true })
        }
      })
    })

    // Initialize video tracking for the first (visible) tab panel
    const firstPanel = wrapper.querySelector('[role="tabpanel"]')
    if (firstPanel) {
      this.initNestedVideoTracking(firstPanel, content?.items?.[0]?.items)
    }
  }

  renderButton(content) {
    const target = content.openInNewTab ? 'target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"' : ''
    const align = content.align || 'center'
    return `
      <div class="button-wrapper button-align-${align}">
        <a href="${sanitizeUrl(content.url)}" class="slate-button button-${escapeHtml(content.style) || 'primary'}" ${target}>
          ${escapeHtml(content.text)}
        </a>
      </div>
    `
  }

  // ============================================
  // xAPI / LRS INTEGRATION
  // ============================================

  initLrsConfig() {
    // Priority 1: Query string parameters (cmi5-style launch)
    const params = new URLSearchParams(window.location.search)
    const endpoint = params.get('endpoint')
    if (endpoint) {
      const actorParam = params.get('actor')
      this.lrsConfig = {
        endpoint: endpoint,
        auth: params.get('auth'),  // Pre-encoded "Basic xxx" header
        actor: actorParam ? JSON.parse(decodeURIComponent(actorParam)) : null
      }
      if (this.debug) console.log('[xAPI] LRS config loaded from query string')
      return
    }

    // Priority 2: JavaScript global (custom integrations)
    if (window.__SLATE_LRS_CONFIG__) {
      this.lrsConfig = window.__SLATE_LRS_CONFIG__
      if (this.debug) console.log('[xAPI] LRS config loaded from window.__SLATE_LRS_CONFIG__')
      return
    }

    // No LRS configured - xAPI statements will not be sent
    this.lrsConfig = null
  }

  getXapiActor() {
    // Priority 1: Actor from LRS config (query string or JS global)
    if (this.lrsConfig?.actor) {
      return this.lrsConfig.actor
    }

    // Priority 2: Try to get learner info from SCORM
    if (this.scorm) {
      const name = this.scorm.LMSGetValue('cmi.core.student_name') || ''
      const id = this.scorm.LMSGetValue('cmi.core.student_id') || ''
      if (id) {
        return {
          objectType: 'Agent',
          name: name || 'Learner',
          account: {
            homePage: window.location.origin,
            name: id
          }
        }
      }
    }

    // Fallback: Anonymous with session ID
    const sessionId = sessionStorage.getItem('slate-session-id') ||
      (() => {
        const id = 'anon-' + Math.random().toString(36).substr(2, 9)
        sessionStorage.setItem('slate-session-id', id)
        return id
      })()
    return {
      objectType: 'Agent',
      name: 'Anonymous Learner',
      account: {
        homePage: window.location.origin,
        name: sessionId
      }
    }
  }

  async sendXapiStatement(statementData) {
    if (!this.lrsConfig || !this.lrsConfig.endpoint) {
      if (this.debug) console.warn('[xAPI] No LRS configured, statement not sent')
      return false
    }

    try {
      // Parse the user's statement JSON
      const userStatement = typeof statementData === 'string'
        ? JSON.parse(statementData)
        : statementData

      // Build complete statement with actor and timestamp
      const statement = {
        actor: this.getXapiActor(),
        ...userStatement,
        timestamp: new Date().toISOString()
      }

      // Build auth header from config
      let authHeader
      if (this.lrsConfig.auth) {
        // Pre-encoded auth from query string (e.g., "Basic abc123")
        authHeader = this.lrsConfig.auth
      } else if (this.lrsConfig.authType === 'basic') {
        // Username/password from JS global
        const credentials = btoa(`${this.lrsConfig.username}:${this.lrsConfig.password}`)
        authHeader = `Basic ${credentials}`
      } else if (this.lrsConfig.key && this.lrsConfig.secret) {
        // Key/secret from JS global
        const credentials = btoa(`${this.lrsConfig.key}:${this.lrsConfig.secret}`)
        authHeader = `Basic ${credentials}`
      } else {
        console.error('[xAPI] No valid authentication configured')
        return false
      }

      // Send to LRS
      const endpoint = this.lrsConfig.endpoint.replace(/\/$/, '') + '/statements'
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'X-Experience-API-Version': '1.0.3'
        },
        body: JSON.stringify(statement)
      })

      if (!response.ok) {
        throw new Error(`LRS responded with ${response.status}`)
      }

      if (this.debug) console.log('[xAPI] Statement sent successfully')
      return true
    } catch (err) {
      console.error('[xAPI] Failed to send statement:', err.message)
      return false
    }
  }

  initButtonXapi(wrapper, content, blockId) {
    const button = wrapper.querySelector('.slate-button')
    if (!button) return

    button.addEventListener('click', () => {
      // Track button click via xAPI wrapper
      if (this.scorm?.trackButtonClick) {
        this.scorm.trackButtonClick(blockId, content.text, content.url)
      }

      // Also send custom xAPI statement if configured
      if (content.xapiStatement) {
        this.sendXapiStatement(content.xapiStatement)
      }
    })
  }

  renderIframe(content) {
    const title = escapeHtml(content.title) || this.t('media.embeddedContent')
    const fsEnabled = content.allowFullscreen !== false
    const allowFs = fsEnabled ? 'allowfullscreen' : ''
    // Modern Chromium requires `allow="fullscreen"` in addition to the legacy
    // attribute for fullscreen to traverse a cross-origin ancestor iframe (e.g.
    // an LMS embedding the SCORM package).
    const allowAttr = fsEnabled ? 'allow="fullscreen"' : ''
    const aspectRatio = content.aspectRatio || 'custom'

    // Use aspect ratio container for known ratios (responsive)
    if (aspectRatio === '16:9' || aspectRatio === '4:3' || aspectRatio === '1:1') {
      const paddingMap = { '16:9': '56.25%', '4:3': '75%', '1:1': '100%' }
      return `
        <div class="iframe-wrapper aspect-ratio" style="padding-bottom: ${paddingMap[aspectRatio]}">
          <iframe
            src="${escapeHtml(sanitizeUrl(content.src))}"
            title="${title}"
            ${allowAttr}
            ${allowFs}
            loading="lazy"
          ></iframe>
        </div>
      `
    }

    // Fixed height for custom/auto
    const height = escapeHtml(content.height) || '400'
    return `
      <div class="iframe-wrapper">
        <iframe
          src="${escapeHtml(sanitizeUrl(content.src))}"
          height="${height}"
          title="${title}"
          ${allowAttr}
          ${allowFs}
          loading="lazy"
        ></iframe>
      </div>
    `
  }

  renderKnowledgeCheck(block) {
    const { question, options, questionType } = block.content

    // Fill in the blank rendering
    if (questionType === 'fill-in-the-blank') {
      return `
        <fieldset class="kc-fieldset" data-question-type="fill-in-the-blank">
          <legend class="kc-question">${sanitizeHtml(question)}</legend>
          <div class="kc-fib-input-wrapper">
            <input type="text" class="kc-text-input"
                   placeholder="${escapeHtml(this.t('quiz.typeAnswer'))}"
                   aria-label="${escapeHtml(this.t('quiz.answerInput'))}"
                   autocomplete="off" />
          </div>
        </fieldset>
        <button class="kc-submit">${escapeHtml(this.t('quiz.submit'))}</button>
        <div class="kc-feedback" role="alert" aria-live="polite"></div>
        <div class="kc-correct-answer" role="status" aria-live="polite"></div>
        <p class="kc-attempt-counter" aria-live="polite"></p>
      `
    }

    const isMultiSelect = questionType === 'multiple-select'
    const groupRole = isMultiSelect ? 'group' : 'radiogroup'
    const optionRole = isMultiSelect ? 'checkbox' : 'radio'
    const optionClass = isMultiSelect ? 'kc-option kc-checkbox' : 'kc-option'

    return `
      <fieldset class="kc-fieldset" data-question-type="${escapeHtml(questionType) || 'multiple-choice'}">
        <legend class="kc-question">${sanitizeHtml(question)}</legend>
        ${isMultiSelect ? `<p class="kc-hint">${escapeHtml(this.t('quiz.selectAll'))}</p>` : ''}
        <div class="kc-options" role="${groupRole}" aria-label="${escapeHtml(this.t('quiz.answerOptions'))}">
          ${options.map((opt, index) => `
            <div class="${optionClass}"
                 role="${optionRole}"
                 aria-checked="false"
                 tabindex="${index === 0 ? '0' : '-1'}"
                 data-option-id="${escapeHtml(opt.id)}">
              ${sanitizeHtml(opt.text)}
            </div>
          `).join('')}
        </div>
      </fieldset>
      <button class="kc-submit">${escapeHtml(this.t('quiz.submit'))}</button>
      <div class="kc-feedback" role="alert" aria-live="polite"></div>
      <p class="kc-attempt-counter" aria-live="polite"></p>
    `
  }

  initKnowledgeCheck(wrapper, block) {
    const submitBtn = wrapper.querySelector('.kc-submit')
    const feedback = wrapper.querySelector('.kc-feedback')
    const attemptCounter = wrapper.querySelector('.kc-attempt-counter')
    const config = this.resolveKcConfig(block)
    const savedKcState = this.knowledgeCheckAttempts?.[block.id] || {}
    let attempts = Math.max(0, Number(savedKcState.attempts) || 0)

    const persistKcState = (patch = {}) => {
      this.knowledgeCheckAttempts = this.knowledgeCheckAttempts || {}
      const current = this.knowledgeCheckAttempts[block.id] || {}
      this.knowledgeCheckAttempts[block.id] = {
        ...current,
        attempts,
        ...patch
      }
    }

    const renderAttemptCounter = () => {
      if (!attemptCounter || config.maxAttempts <= 0) return
      attemptCounter.textContent = this.t('quiz.attemptCount', {
        current: Math.min(attempts, config.maxAttempts),
        max: config.maxAttempts
      })
      attemptCounter.classList.add('show')
    }

    const renderFeedback = (isCorrect) => {
      if (!config.showFeedback) {
        feedback.className = 'kc-feedback'
        feedback.textContent = ''
        return
      }
      const text = isCorrect
        ? block.content.feedback.correct
        : block.content.feedback.incorrect
      feedback.textContent = text
      feedback.className = `kc-feedback show ${isCorrect ? 'correct' : 'incorrect'}`
    }

    if (attempts > 0) {
      renderAttemptCounter()
    }

    // Fill in the blank branch
    if (block.content.questionType === 'fill-in-the-blank') {
      const textInput = wrapper.querySelector('.kc-text-input')
      const correctAnswerDiv = wrapper.querySelector('.kc-correct-answer')
      let isLocked = savedKcState.locked === true

      const lockFib = () => {
        isLocked = true
        textInput.readOnly = true
        submitBtn.disabled = true
      }

      const revealAcceptedAnswer = () => {
        if (!correctAnswerDiv) return
        const accepted = block.content.acceptedAnswers || []
        if (accepted.length === 0) return
        correctAnswerDiv.textContent = this.t('quiz.correctAnswer', { answer: accepted[0] })
        correctAnswerDiv.classList.add('show')
      }

      if (savedKcState.lastAnswer) {
        textInput.value = savedKcState.lastAnswer
      }

      if (isLocked) {
        if (savedKcState.isCorrect) {
          textInput.classList.add('correct')
          renderFeedback(true)
        } else {
          if (savedKcState.showInputIncorrect) {
            textInput.classList.add('incorrect')
          }
          renderFeedback(false)
          if (savedKcState.revealedCorrectAnswer) {
            revealAcceptedAnswer()
          }
        }
        lockFib()
      }

      const submitFib = () => {
        if (isLocked) return
        const userAnswer = textInput.value.trim()
        if (!userAnswer) return

        const isCorrect = this.checkFibCorrectness(
          userAnswer,
          block.content.acceptedAnswers || [],
          block.content.caseSensitive || false
        )

        this.recordFibInteraction({
          id: block.id,
          question: block.content.question,
          userAnswer,
          acceptedAnswers: block.content.acceptedAnswers || [],
          correct: isCorrect
        })

        textInput.classList.remove('correct', 'incorrect')

        if (isCorrect) {
          // Correct submission: always paint and lock, regardless of revealAnswersPerAttempt.
          textInput.classList.add('correct')
          renderFeedback(true)
          lockFib()
          persistKcState({
            locked: true,
            isCorrect: true,
            lastAnswer: userAnswer,
            showInputIncorrect: false,
            revealedCorrectAnswer: false
          })
        } else {
          attempts += 1
          const showInputIncorrect = !!config.revealAnswersPerAttempt
          if (config.revealAnswersPerAttempt) {
            textInput.classList.add('incorrect')
          }
          renderFeedback(false)
          renderAttemptCounter()
          let lockedByCap = false
          let revealedCorrectAnswer = false
          if (config.maxAttempts > 0 && attempts >= config.maxAttempts) {
            // Cap reached: lock and optionally reveal.
            lockedByCap = true
            lockFib()
            if (config.revealCorrectAnswer) {
              revealAcceptedAnswer()
              revealedCorrectAnswer = true
            }
          }
          persistKcState({
            locked: lockedByCap,
            isCorrect: false,
            lastAnswer: userAnswer,
            showInputIncorrect,
            revealedCorrectAnswer
          })
        }

        if (this.scorm?.trackKnowledgeCheck) {
          const questionText = block.content.question.replace(/<[^>]*>/g, '')
          const feedbackText = isCorrect
            ? block.content.feedback.correct
            : block.content.feedback.incorrect
          this.scorm.trackKnowledgeCheck({
            blockId: block.id,
            questionText,
            questionType: 'fill-in-the-blank',
            allOptions: (block.content.acceptedAnswers || []).map((a, i) => ({
              id: `accepted-${i}`,
              text: a,
              isCorrect: true
            })),
            selectedOptionIds: [userAnswer],
            isCorrect,
            feedbackText,
            lessonTitle: this.currentLesson?.title
          })
        }

        this.completedChecks.add(block.id)
        this.updateProgress()
        this.saveProgress()
        this.refreshGateUI()
      }

      // Clear stale feedback when the learner edits their answer for a retry.
      textInput.addEventListener('input', () => {
        if (isLocked) return
        textInput.classList.remove('correct', 'incorrect')
        if (feedback.classList.contains('show')) {
          feedback.className = 'kc-feedback'
          feedback.textContent = ''
        }
        if (correctAnswerDiv?.classList.contains('show')) {
          correctAnswerDiv.classList.remove('show')
          correctAnswerDiv.textContent = ''
        }
      })

      submitBtn.addEventListener('click', submitFib)
      textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitFib()
      })
      return
    }

    // MC/MS branch
    const options = wrapper.querySelectorAll('.kc-option')
    const isMultiSelect = block.content.questionType === 'multiple-select'
    const isMultipleChoice = block.content.questionType === 'multiple-choice'
    const selectedIds = new Set()
    let isLocked = savedKcState.locked === true

    // Clear post-submit visuals so a retry starts from a clean slate.
    // The attempt counter persists between attempts, as does the .eliminated
    // class on options (process-of-elimination state from earlier attempts).
    const clearAttemptVisuals = () => {
      options.forEach(opt => opt.classList.remove('correct', 'incorrect', 'missed'))
      if (feedback.classList.contains('show')) {
        feedback.className = 'kc-feedback'
        feedback.textContent = ''
      }
    }

    // MC-only: mark wrong picks as eliminated for subsequent attempts. Adds
    // the .eliminated class and aria-disabled='true' so setupKcOptionHandlers
    // refuses to re-select them. MS and FIB ignore this setting (combinatorial
    // wrong-state semantics aren't well-defined for MS, and FIB has no options).
    const eliminateSelected = () => {
      options.forEach(opt => {
        if (selectedIds.has(opt.dataset.optionId)) {
          opt.classList.add('eliminated')
          opt.classList.remove('selected')
          opt.setAttribute('aria-disabled', 'true')
          opt.setAttribute('aria-checked', 'false')
          opt.setAttribute('tabindex', '-1')
        }
      })
      selectedIds.clear()
    }

    const applyEliminatedOptions = (optionIds = []) => {
      const eliminatedIds = new Set(optionIds)
      options.forEach(opt => {
        if (eliminatedIds.has(opt.dataset.optionId)) {
          opt.classList.add('eliminated')
          opt.classList.remove('selected')
          opt.setAttribute('aria-disabled', 'true')
          opt.setAttribute('aria-checked', 'false')
          opt.setAttribute('tabindex', '-1')
        }
      })
    }

    const getEliminatedOptionIds = () =>
      Array.from(options)
        .filter(opt => opt.classList.contains('eliminated'))
        .map(opt => opt.dataset.optionId)
        .filter(Boolean)

    if (Array.isArray(savedKcState.eliminatedOptionIds)) {
      applyEliminatedOptions(savedKcState.eliminatedOptionIds)
    }

    if (isLocked) {
      const savedSelectedIds = new Set(savedKcState.selectedOptionIds || [])
      savedSelectedIds.forEach(id => {
        const selectedOpt = wrapper.querySelector(`[data-option-id="${id}"]`)
        if (selectedOpt && !selectedOpt.classList.contains('eliminated')) {
          selectedOpt.classList.add('selected')
          selectedOpt.setAttribute('aria-checked', 'true')
        }
      })
      if (savedKcState.showOptionFeedback) {
        this.showKcOptionFeedback(options, savedSelectedIds, block.content.options)
      }
      renderFeedback(!!savedKcState.isCorrect)
      this.disableKcOptions(options, submitBtn)
    }

    this.setupKcOptionHandlers(options, isMultiSelect, selectedIds, () => {
      if (!isLocked) clearAttemptVisuals()
    })

    submitBtn.addEventListener('click', () => {
      if (isLocked) return
      if (selectedIds.size === 0) return

      const submittedIds = Array.from(selectedIds)
      const isCorrect = this.calcKcCorrectness(selectedIds, block.content.options)

      this.recordInteraction({
        id: block.id,
        type: block.content.questionType || 'multiple-choice',
        question: block.content.question,
        options: block.content.options,
        selectedIds: submittedIds,
        correct: isCorrect
      })

      if (isCorrect) {
        // Correct submission: always paint per-option and lock, regardless of revealAnswersPerAttempt.
        this.showKcOptionFeedback(options, selectedIds, block.content.options)
        renderFeedback(true)
        isLocked = true
        this.disableKcOptions(options, submitBtn)
        persistKcState({
          locked: true,
          isCorrect: true,
          selectedOptionIds: submittedIds,
          showOptionFeedback: true,
          eliminatedOptionIds: getEliminatedOptionIds()
        })
      } else {
        attempts += 1
        let showOptionFeedback = false
        if (config.revealAnswersPerAttempt) {
          this.showKcOptionFeedback(options, selectedIds, block.content.options)
          showOptionFeedback = true
        }
        renderFeedback(false)
        renderAttemptCounter()
        const capReached = config.maxAttempts > 0 && attempts >= config.maxAttempts
        if (capReached) {
          // Cap reached: lock. If author asked to reveal, paint the correct options
          // even when revealAnswersPerAttempt is false — this is the lock moment.
          if (config.revealCorrectAnswer) {
            this.showKcOptionFeedback(options, selectedIds, block.content.options)
            showOptionFeedback = true
          }
          isLocked = true
          this.disableKcOptions(options, submitBtn)
        } else if (isMultipleChoice && config.eliminateWrongOptions) {
          // Eliminate wrong picks across attempts (MC only). Runs only when
          // the question is still retryable — at the cap-reached lock above,
          // every option is already disabled.
          eliminateSelected()
        }
        persistKcState({
          locked: capReached,
          isCorrect: false,
          selectedOptionIds: submittedIds,
          showOptionFeedback,
          eliminatedOptionIds: getEliminatedOptionIds()
        })
      }

      if (this.scorm?.trackKnowledgeCheck) {
        const questionText = block.content.question.replace(/<[^>]*>/g, '')
        const feedbackText = isCorrect
          ? block.content.feedback.correct
          : block.content.feedback.incorrect
        this.scorm.trackKnowledgeCheck({
          blockId: block.id,
          questionText: questionText,
          questionType: block.content.questionType || 'multiple-choice',
          allOptions: block.content.options.map(opt => ({
            id: opt.id,
            text: opt.text.replace(/<[^>]*>/g, ''),
            isCorrect: opt.correct === true || opt.correct === 'true'
          })),
          selectedOptionIds: submittedIds,
          isCorrect: isCorrect,
          feedbackText: feedbackText,
          lessonTitle: this.currentLesson?.title
        })
      }

      this.completedChecks.add(block.id)
      this.updateProgress()
      this.saveProgress()
      this.refreshGateUI()
    })
  }

  observeBlock(element, blockId) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            // Block viewed - update progress
            this.updateProgress()
            this.saveProgress()
          }
        })
      },
      { threshold: 0.5 }
    )
    observer.observe(element)
  }

  // ============================================
  // NAVIGATION CONTROLS
  // ============================================

  setupNavButtons() {
    // Skip if already initialized (hot-reload safe)
    if (this.navButtonsInitialized) {
      this.updateNavButtons()
      return
    }

    const prevBtn = document.getElementById('btn-prev')
    const nextBtn = document.getElementById('btn-next')

    if (prevBtn) {
      prevBtn.addEventListener('click', () => this.goToPrevLesson())
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.goToNextLesson())
    }

    this.navButtonsInitialized = true
    this.updateNavButtons()
  }

  isLockedNavigation() {
    if (this.reviewMode) return false
    if (this.course?.settings?.lessonPacing === true) return true
    if (!this.course?.settings?.lockedNavigation) return false
    return true
  }

  // --- Lesson completion gate (require finishing a lesson before advancing) ---

  isRequireLessonCompletion() {
    if (this.course?.settings?.requireLessonCompletion !== true) return false
    if (this.reviewMode) return false
    return true
  }

  // Stricter sub-option of the completion gate: also require the learner to
  // actively engage with every top-level interactive block (flip every card,
  // open every accordion panel, view every tab, reach the end of a carousel).
  // Only meaningful as a layer on top of requireLessonCompletion, so it inherits
  // that gate's review-mode / cover-conclusion exemptions.
  isRequireInteraction() {
    if (!this.isRequireLessonCompletion()) return false
    return this.course?.settings?.requireInteraction === true
  }

  // Independent time gate: hold Next until each lesson's per-lesson minimum
  // (lesson.pacingSeconds) has elapsed. Unlike requireInteraction it does NOT
  // require requireLessonCompletion — a course can enforce time on its own.
  // Review/preview are exempt, mirroring the completion gate.
  isLessonPacing() {
    if (this.course?.settings?.lessonPacing !== true) return false
    if (this.reviewMode) return false
    return true
  }

  // Start the 1s pacing tick plus a save-on-hidden hook (idempotent). Created
  // lazily because most courses don't pace; cleared implicitly on unload.
  setupPacingTimer() {
    if (!this.isLessonPacing() || this.pacingTimerId) return
    // Clear any interval/listener left by a previous player instance in the SAME
    // document. SCORM/standalone is one-player-per-page, but the builder's live
    // preview can re-instantiate the player without a page unload, which would
    // otherwise leak the 1s interval and the visibilitychange handler.
    if (typeof window !== 'undefined' && window.__slatePacingTeardown) window.__slatePacingTeardown()
    // Persist accrued time the instant the learner leaves. visibilitychange ->
    // hidden is the browser-recommended "save state now" signal and also fires
    // on tab close (where unload/beforeunload are unreliable), so a mid-lesson
    // suspend resumes with no lost time. saveProgress() self-guards on the SCORM
    // driver (no-op in standalone/preview).
    const onVisibility = () => { if (document.hidden) this.saveProgress() }
    document.addEventListener('visibilitychange', onVisibility)
    this.pacingTimerId = setInterval(() => this.pacingTick(), 1000)
    if (typeof window !== 'undefined') {
      window.__slatePacingTeardown = () => {
        clearInterval(this.pacingTimerId)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }

  // Accrue one second of "active" time on the current paced lesson. Active =
  // the tab is visible; we deliberately do NOT pause on input-idle, because
  // silently reading a long passage is exactly the time we want to count.
  // Backgrounding the tab (document.hidden) pauses it, so a learner can't leave
  // it open in another tab to wait out the minimum.
  pacingTick() {
    if (!this.isLessonPacing() || document.hidden) return
    if (this.showingCoverPage || this.showingConclusionPage) return
    if (this.isCurrentSectionAssessment()) return
    const lesson = this.currentLesson
    const need = lesson?.pacingSeconds || 0
    if (!lesson?.id || need <= 0) return
    const elapsed = this.lessonPacingElapsed.get(lesson.id) || 0
    if (elapsed >= need) return
    const next = elapsed + 1
    this.lessonPacingElapsed.set(lesson.id, next)
    // Each second only the countdown TEXT changes, so do a cheap in-place update.
    // The full refreshGateUI() (which rebuilds the vertical up-next card) runs
    // only when the gate actually clears, to avoid per-second DOM churn and
    // focus loss during the countdown.
    if (next >= need) this.refreshGateUI()
    else this.updatePacingCountdown()
    // Checkpoint periodically, and the moment the gate clears, so a resume keeps
    // accrued time without committing to the LMS every second.
    if (next >= need || next % 10 === 0) this.saveProgress()
  }

  // Remaining seconds on the current paced lesson, formatted as a M:SS
  // countdown for the gated Next affordance ("Available in 2:14").
  formatPacingCountdown(seconds) {
    const s = Math.max(0, Math.floor(seconds))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  // Update only the visible countdown text (Next button + vertical up-next card),
  // in place — without the full nav rebuild refreshGateUI does. Called each second
  // while a pacing gate counts down. No-op unless the current gate reason is
  // 'pacing', so it never clobbers a questions/scroll hint.
  updatePacingCountdown() {
    const reason = this.getLessonGateReason(this.currentLesson)
    if (reason !== 'pacing') return
    const hint = this.gateHintText(this.currentLesson, reason)
    const nextBtn = document.getElementById('btn-next')
    if (nextBtn && nextBtn.classList.contains('nav-gated')) {
      nextBtn.textContent = hint
      nextBtn.setAttribute('title', hint)
    }
    const meta = document.querySelector('.vertical-nav-next-card.nav-gated .vertical-nav-next-meta')
    if (meta) meta.textContent = hint
  }

  // Register a top-level interactive block as an interaction-gate target. Called
  // from the init functions with gateTrack=true. `total` is the number of units
  // (panels/tabs/cards) the learner must reveal. Blocks already satisfied from a
  // restored session are skipped; a target of 0 auto-satisfies (nothing to do).
  // NOTE: named *BlockInteraction to avoid colliding with the xAPI
  // `recordInteraction({...})` knowledge-check tracker defined later in this file
  // (a same-name method would shadow these on the prototype).
  registerBlockInteraction(blockId, total) {
    if (!this.isRequireInteraction() || !blockId) return
    if (this.completedInteractions.has(blockId)) return
    this.interactionTargets.set(blockId, total)
    this.interactionSeen.set(blockId, new Set())
    if (total <= 0) this.markBlockInteractionDone(blockId)
  }

  // Record that the learner revealed one unit (a panel index, tab index, card
  // index, or the 'flipped'/'end' sentinel) of an interactive block. When every
  // unit has been seen, the block is marked done and the gate UI refreshes.
  recordBlockInteraction(blockId, key) {
    if (!this.isRequireInteraction() || !blockId) return
    if (this.completedInteractions.has(blockId)) return
    const seen = this.interactionSeen.get(blockId)
    if (!seen) return
    seen.add(key)
    if (seen.size >= (this.interactionTargets.get(blockId) || 0)) {
      this.markBlockInteractionDone(blockId)
    }
  }

  markBlockInteractionDone(blockId) {
    this.completedInteractions.add(blockId)
    this.refreshGateUI()
    this.saveProgress()
  }

  // Returns the reason the current lesson isn't finished yet
  // ('questions' | 'interactions' | 'scroll' | 'pacing'), or null when the
  // lesson is complete and the learner may advance.
  getLessonGateReason(lesson) {
    if (!lesson) return null
    const blocks = lesson.blocks || []
    // Completion-gate reasons (questions -> interactions -> scroll) apply only
    // when requireLessonCompletion is on. Pacing is independent and checked last.
    if (this.isRequireLessonCompletion()) {
      // 1) Every knowledge check on the lesson must be answered. Only top-level KC
      //    blocks are considered — matching isComplete()'s convention. Knowledge
      //    checks nested inside layout/accordion/tabs are not wired for completion
      //    (initNestedBlocks has no knowledge-check case), so requiring them here
      //    would deadlock the gate with no way to satisfy it.
      const kcs = blocks.filter(b => b.type === 'knowledge-check')
      if (!kcs.every(b => this.completedChecks.has(b.id))) return 'questions'
      // 2) Every top-level interactive block must be fully explored (only when
      //    requireInteraction is on). Only blocks that registered a target during
      //    init can gate, so a malformed block whose init bailed early — or a
      //    nested block (never registered, mirroring the KC carve-out above) —
      //    cannot deadlock the gate with no way to satisfy it.
      if (this.isRequireInteraction()) {
        const unmet = blocks.some(b =>
          this.interactionTargets.has(b.id) && !this.completedInteractions.has(b.id))
        if (unmet) return 'interactions'
      }
      // 3) The learner must have scrolled to the end of the content. Lessons that
      //    don't overflow are marked reached automatically (see evaluateLessonReachedEnd).
      if (!this.lessonsReachedEnd.has(lesson.id)) return 'scroll'
    }
    // 4) Lesson Pacing: hold until the per-lesson minimum time has elapsed.
    //    Checked last because time accrues in the background while the learner
    //    reads, so it's typically the final reason to clear.
    if (this.isLessonPacing()) {
      const need = lesson.pacingSeconds || 0
      if (need > 0 && (this.lessonPacingElapsed.get(lesson.id) || 0) < need) return 'pacing'
    }
    return null
  }

  // Localized hint for why the lesson isn't finished. Single source of truth for
  // the toast, the Next button title, and the vertical up-next card.
  gateHintText(lesson, reason = this.getLessonGateReason(lesson)) {
    if (reason === 'questions') return this.t('nav.completeQuestions')
    if (reason === 'interactions') return this.t('nav.completeInteractions')
    if (reason === 'pacing') {
      const remaining = Math.max(0, (lesson?.pacingSeconds || 0) - (this.lessonPacingElapsed.get(lesson?.id) || 0))
      return this.t('nav.completePacing', { time: this.formatPacingCountdown(remaining) })
    }
    return this.t('nav.completeScroll')
  }

  // True when forward navigation should be held back by the completion gate.
  // Cover/conclusion pages are exempt: currentLesson still resolves to a real
  // lesson there, but its content isn't on screen, so gating against it would
  // wrongly block (or auto-satisfy) a lesson the learner hasn't actually seen.
  isNextGated() {
    if (!this.isRequireLessonCompletion() && !this.isLessonPacing()) return false
    if (this.showingCoverPage || this.showingConclusionPage) return false
    if (this.isCurrentSectionAssessment()) return false
    return this.getLessonGateReason(this.currentLesson) !== null
  }

  // Announce why the learner can't advance yet via a polite, focus-preserving
  // live region (WCAG 4.1.3). The region is pre-created in setupCompletionGate.
  announceLessonGate() {
    const reason = this.getLessonGateReason(this.currentLesson)
    if (!reason) return
    const toast = document.getElementById('completion-gate-toast')
    if (!toast) return
    const msg = this.gateHintText(this.currentLesson)
    // Clear then set on the next frame so screen readers re-announce repeat presses.
    toast.textContent = ''
    requestAnimationFrame(() => { toast.textContent = msg })
    toast.classList.add('visible')
    clearTimeout(this._gateToastTimer)
    this._gateToastTimer = setTimeout(() => toast.classList.remove('visible'), 5000)
  }

  // Refresh every surface that reflects the gate state after it may have changed
  // (scroll-to-end reached, a knowledge check answered). Central hook so callers
  // don't have to know which navigation chrome exists.
  refreshGateUI() {
    if (!this.isRequireLessonCompletion() && !this.isLessonPacing()) return
    this.updateNavButtons()
    if (this.isLockedNavigation()) this.refreshLockedNavigationUI()
    // The vertical layout draws its own up-next card whose gated state is baked
    // in at render time; rebuild it so it stops advertising itself as locked
    // once the gate clears (mirrors the locked-navigation rebuild path).
    if (this.isVerticalLayout) {
      const container = document.getElementById('player-content')
      if (container) this.refreshVerticalInlineNav(container)
    }
  }

  setupCompletionGate() {
    if (!this.isRequireLessonCompletion() && !this.isLessonPacing()) return

    // Pre-create the (empty) live region so screen readers watch it for changes.
    if (!document.getElementById('completion-gate-toast')) {
      const toast = document.createElement('div')
      toast.id = 'completion-gate-toast'
      toast.className = 'completion-gate-toast'
      toast.setAttribute('role', 'status')
      toast.setAttribute('aria-live', 'polite')
      const body = document.getElementById('player-body') || document.body
      body.appendChild(toast)
    }

    // Lesson Pacing runs an independent 1s timer (no scroll listener needed).
    this.setupPacingTimer()

    // Attach the scroll listener once. It lives on #player-content, which is
    // reused across lessons (innerHTML is swapped, the element persists), so it
    // neither leaks nor needs re-binding per lesson. No window-resize listener:
    // reached-end is re-evaluated on the deferred post-render check instead,
    // which avoids accumulating listeners across builder live-preview re-inits.
    if (this.completionGateInitialized) return
    const content = document.getElementById('player-content')
    if (!content) return
    content.addEventListener('scroll', () => this.evaluateLessonReachedEnd(), { passive: true })
    this.completionGateInitialized = true
  }

  hasPendingLessonLayoutMedia(content) {
    const pendingImage = Array.from(content.querySelectorAll('img'))
      .some(img => !img.complete)
    const pendingVideo = Array.from(content.querySelectorAll('video'))
      .some(video => video.readyState < 1)
    return pendingImage || pendingVideo
  }

  watchLessonLayoutMedia(content) {
    const onSettled = () => requestAnimationFrame(() => this.evaluateLessonReachedEnd())

    content.querySelectorAll('img').forEach(img => {
      if (img.dataset.completionGateWatched) return
      img.dataset.completionGateWatched = 'true'
      img.addEventListener('load', onSettled, { once: true })
      img.addEventListener('error', onSettled, { once: true })
    })

    content.querySelectorAll('video').forEach(video => {
      if (video.dataset.completionGateWatched) return
      video.dataset.completionGateWatched = 'true'
      video.addEventListener('loadedmetadata', onSettled, { once: true })
      video.addEventListener('error', onSettled, { once: true })
    })
  }

  // Mark the current lesson "reached the end" when the learner is at (or near)
  // the bottom, or when the content is too short to scroll. Skips the
  // cover/conclusion pages (their DOM isn't the lesson's content).
  evaluateLessonReachedEnd() {
    if (!this.isRequireLessonCompletion()) return
    if (this.showingCoverPage || this.showingConclusionPage) return
    const lesson = this.currentLesson
    if (!lesson?.id || this.lessonsReachedEnd.has(lesson.id)) return
    const content = document.getElementById('player-content')
    if (!content) return
    const distanceFromBottom = content.scrollHeight - content.scrollTop - content.clientHeight
    // 40px slack covers sub-pixel rounding and short, non-scrolling lessons.
    if (distanceFromBottom <= 40) {
      if (this.hasPendingLessonLayoutMedia(content)) {
        this.watchLessonLayoutMedia(content)
        return
      }
      this.lessonsReachedEnd.add(lesson.id)
      this.refreshGateUI()
      this.saveProgress()
    }
  }

  // Re-evaluate reached-end after a lesson renders, deferred so media has laid
  // out before we measure (mirrors updateScrollIndicator's settle timing). A
  // synchronous check would measure scrollHeight before images establish their
  // height and wrongly mark a tall media lesson as already scrolled.
  scheduleReachedEndCheck() {
    if (!this.isRequireLessonCompletion()) return
    const content = document.getElementById('player-content')
    if (content) this.watchLessonLayoutMedia(content)
    requestAnimationFrame(() => {
      this.evaluateLessonReachedEnd()
      setTimeout(() => this.evaluateLessonReachedEnd(), 500)
    })
  }

  isAssessmentAutoscroll() {
    if (this.course?.settings?.assessmentAutoscroll === false) return false
    return true
  }

  getNavLockTitle(sectionIndex, lessonIndex, fallbackTitle) {
    if (this.isImmediateForwardNavigationGated(sectionIndex, lessonIndex)) {
      return this.gateHintText(this.currentLesson)
    }
    return fallbackTitle || this.t('nav.locked')
  }

  setNavLessonLockedState(el, isLocked, title) {
    el.classList.toggle('nav-locked', isLocked)
    el.setAttribute('tabindex', isLocked ? '-1' : '0')
    if (isLocked) el.setAttribute('aria-disabled', 'true')
    else el.removeAttribute('aria-disabled')
    if (title) el.setAttribute('title', title)

    const existingIcon = el.querySelector('.nav-lock-icon')
    if (isLocked && !existingIcon) {
      el.insertAdjacentHTML('beforeend', '<svg class="nav-lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>')
    } else if (!isLocked && existingIcon) {
      existingIcon.remove()
    }
  }

  refreshLockedNavigationUI() {
    const nav = document.getElementById('player-nav')
    if (!nav) return

    nav.querySelectorAll('.nav-lesson[data-section][data-lesson]').forEach(el => {
      const sectionIndex = parseInt(el.dataset.section)
      const lessonIndex = parseInt(el.dataset.lesson)
      if (Number.isNaN(sectionIndex) || Number.isNaN(lessonIndex)) return

      const section = this.course?.sections?.[sectionIndex]
      const lesson = section?.lessons?.[lessonIndex]
      const fallbackTitle = this.getTranslatedLessonTitle(lesson || {})
      const isAssessment = section?.isAssessment === true
      const isGateLocked = this.isForwardNavigationGated(sectionIndex, lessonIndex)
      const isLocked = isAssessment
        ? this.isAssessmentLocked()
        : (isGateLocked || !this.isLessonAccessible(sectionIndex, lessonIndex))
      const title = isLocked
        ? this.getNavLockTitle(sectionIndex, lessonIndex, fallbackTitle)
        : fallbackTitle

      this.setNavLessonLockedState(el, isLocked, title)
    })

    if (this.isSearching && this.searchQuery?.length >= 2) {
      const results = this.performSearch(this.searchQuery)
      this.renderSearchResults(results)
    }
  }

  getNavigationOrderIndex(sectionIndex, lessonIndex) {
    const sections = this.course?.sections || []
    let globalIndex = 0

    for (let si = 0; si < sections.length; si++) {
      if (sections[si].isAssessment) {
        if (si === sectionIndex) return globalIndex
        globalIndex++
        continue
      }

      for (let li = 0; li < sections[si].lessons.length; li++) {
        const lesson = sections[si].lessons[li]
        if (this.isConclusionLesson(lesson) || this.isCoverLesson(lesson)) continue
        if (si === sectionIndex && li === lessonIndex) return globalIndex
        globalIndex++
      }
    }

    return -1
  }

  isImmediateForwardNavigationGated(sectionIndex, lessonIndex) {
    if (!this.isNextGated()) return false
    const currentIndex = this.getNavigationOrderIndex(this.currentSectionIndex, this.currentLessonIndex)
    const targetIndex = this.getNavigationOrderIndex(sectionIndex, lessonIndex)
    return currentIndex >= 0 && targetIndex === currentIndex + 1
  }

  isForwardNavigationGated(sectionIndex, lessonIndex) {
    if (!this.isNextGated()) return false
    const currentIndex = this.getNavigationOrderIndex(this.currentSectionIndex, this.currentLessonIndex)
    const targetIndex = this.getNavigationOrderIndex(sectionIndex, lessonIndex)
    return currentIndex >= 0 && targetIndex > currentIndex
  }

  isLessonAccessible(sectionIndex, lessonIndex) {
    if (!this.isLockedNavigation()) return true
    if (sectionIndex === this.currentSectionIndex && lessonIndex === this.currentLessonIndex) return true

    // Assessment sections: accessible only when all content lessons are viewed
    const sections = this.course.sections
    if (sections[sectionIndex]?.isAssessment) {
      return this.allContentLessonsViewed()
    }

    let targetGlobalIndex = -1
    let furthestViewedGlobalIndex = -1
    let globalIndex = 0

    for (let si = 0; si < sections.length; si++) {
      if (sections[si].isAssessment) continue
      for (let li = 0; li < sections[si].lessons.length; li++) {
        const lesson = sections[si].lessons[li]
        if (this.isConclusionLesson(lesson) || this.isCoverLesson(lesson)) continue  // Skip conclusion/cover lesson
        if (si === sectionIndex && li === lessonIndex) {
          targetGlobalIndex = globalIndex
        }
        if (this.viewedLessons.has(lesson.id)) {
          furthestViewedGlobalIndex = globalIndex
        }
        globalIndex++
      }
    }

    return targetGlobalIndex <= furthestViewedGlobalIndex + 1
  }

  updateNavButtons() {
    const prevBtn = document.getElementById('btn-prev')
    const nextBtn = document.getElementById('btn-next')

    if (prevBtn) {
      prevBtn.disabled = this.currentSectionIndex === 0 && this.currentLessonIndex === 0
    }
    if (nextBtn) {
      const lastSection = this.course.sections.length - 1
      const lastLesson = this.course.sections[lastSection]?.lessons.length - 1 || 0
      const isLast = this.currentSectionIndex === lastSection && this.currentLessonIndex === lastLesson

      let nextSection = this.currentSectionIndex
      let nextLesson = this.currentLessonIndex
      if (this.currentLessonIndex < (this.currentSection?.lessons?.length || 1) - 1) {
        nextLesson = this.currentLessonIndex + 1
      } else if (this.currentSectionIndex < this.course.sections.length - 1) {
        nextSection = this.currentSectionIndex + 1
        nextLesson = 0
      }

      const hardDisabled = isLast || this.isCurrentSectionAssessment() || !this.isLessonAccessible(nextSection, nextLesson)
      nextBtn.disabled = hardDisabled

      // Completion gate: keep the button enabled (focusable + clickable) but mark it
      // aria-disabled so activating it surfaces the polite "finish this lesson" toast
      // instead of silently doing nothing (a native `disabled` would swallow that).
      const gated = !hardDisabled && this.isNextGated()
      if (gated) {
        const reason = this.getLessonGateReason(this.currentLesson)
        const isPacing = reason === 'pacing'
        const hint = this.gateHintText(this.currentLesson, reason)
        nextBtn.setAttribute('aria-disabled', 'true')
        nextBtn.setAttribute('title', hint)
        nextBtn.classList.add('nav-gated')
        // Pacing replaces the "Next" label with a live countdown so the learner
        // can see how long is left; other gate reasons keep the label and rely
        // on the title/toast hint.
        nextBtn.textContent = isPacing ? hint : this.t('nav.next')
        // ...but pin the ACCESSIBLE name to a stable "Next" while the visible
        // label ticks, so screen readers don't re-announce the countdown every
        // second when the button is focused. The remaining time is announced on
        // demand via the polite toast when a gated Next is activated
        // (announceLessonGate). Mirrors the vertical up-next card's stable label.
        if (isPacing) nextBtn.setAttribute('aria-label', this.t('nav.next'))
        else nextBtn.removeAttribute('aria-label')
      } else {
        nextBtn.removeAttribute('aria-disabled')
        nextBtn.removeAttribute('title')
        nextBtn.removeAttribute('aria-label')
        nextBtn.classList.remove('nav-gated')
        nextBtn.textContent = this.t('nav.next')
      }
    }
  }

  goToLesson(sectionIndex, lessonIndex) {
    if (this.isForwardNavigationGated(sectionIndex, lessonIndex)) return
    if (!this.isLessonAccessible(sectionIndex, lessonIndex)) return
    this.showingConclusionPage = false
    this.showingCoverPage = false
    this.currentSectionIndex = sectionIndex
    this.currentLessonIndex = lessonIndex
    this.renderCurrentLesson()
    this.renderNavigation()
    this.updateNavButtons()
    this.updateProgress()

    // Track lesson view for Share & Track (skip assessment sections)
    const lesson = this.currentLesson
    if (lesson?.id && this.trackingConfig && !this.isCurrentSectionAssessment()) {
      this.trackLessonView(lesson.id)
    }
  }

  goToNextLesson() {
    const section = this.currentSection
    let nextSection = this.currentSectionIndex
    let nextLesson = this.currentLessonIndex

    if (this.currentLessonIndex < section.lessons.length - 1) {
      nextLesson = this.currentLessonIndex + 1
    } else if (this.currentSectionIndex < this.course.sections.length - 1) {
      nextSection = this.currentSectionIndex + 1
      nextLesson = 0
    } else {
      return
    }

    // Completion gate: hold the learner on this lesson until it's finished, and
    // explain why via a polite live-region announcement.
    if (this.isNextGated()) {
      this.announceLessonGate()
      return
    }

    if (!this.isLessonAccessible(nextSection, nextLesson)) return

    this.showingConclusionPage = false
    this.showingCoverPage = false
    this.currentSectionIndex = nextSection
    this.currentLessonIndex = nextLesson
    this.renderCurrentLesson()
    this.renderNavigation()
    this.updateNavButtons()
    this.updateProgress()

    // Track lesson view for Share & Track (skip assessment sections)
    const nextLessonObj = this.currentLesson
    if (nextLessonObj?.id && this.trackingConfig && !this.isCurrentSectionAssessment()) {
      this.trackLessonView(nextLessonObj.id)
    }
  }

  goToPrevLesson() {
    this.showingConclusionPage = false
    this.showingCoverPage = false
    if (this.currentLessonIndex > 0) {
      this.currentLessonIndex--
    } else if (this.currentSectionIndex > 0) {
      this.currentSectionIndex--
      this.currentLessonIndex = this.course.sections[this.currentSectionIndex].lessons.length - 1
    }
    this.renderCurrentLesson()
    this.renderNavigation()
    this.updateNavButtons()
    this.updateProgress()

    // Track lesson view for Share & Track (skip assessment sections)
    const lesson = this.currentLesson
    if (lesson?.id && this.trackingConfig && !this.isCurrentSectionAssessment()) {
      this.trackLessonView(lesson.id)
    }
  }

  // --- Vertical Layout Methods ---

  renderVerticalProgressBar() {
    if (document.getElementById('vertical-progress-bar')) return

    const header = document.getElementById('player-header')
    if (!header) return

    const bar = document.createElement('div')
    bar.id = 'vertical-progress-bar'
    bar.className = 'vertical-progress-bar'
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', '100')
    bar.setAttribute('aria-valuenow', '0')
    bar.setAttribute('aria-label', this.t('a11y.courseProgress'))

    const fill = document.createElement('div')
    fill.id = 'vertical-progress-fill'
    fill.className = 'vertical-progress-fill'
    bar.appendChild(fill)

    header.insertAdjacentElement('afterend', bar)
  }

  // Remove and rebuild the vertical inline nav cards in place. Used whenever the
  // up-next card's state changes outside a full lesson render (locked-nav unlock,
  // completion gate clearing).
  refreshVerticalInlineNav(container) {
    container.querySelector('.vertical-nav-prev')?.remove()
    container.querySelector('.vertical-nav-next-card')?.remove()
    container.querySelector('.vertical-end-card')?.remove()
    this.renderVerticalInlineNav(container)
  }

  renderVerticalInlineNav(container) {
    // Single source of truth for the nav-chrome skip: when the menu is off on a
    // single-screen course we render no inline prev / up-next card. Guarding here
    // (not only at the initial-render callsite) also covers the language-switch,
    // locked-nav, and gate-clear rebuild paths.
    if (this.navChromeHidden) return
    const sections = this.course.sections
    const isFirst = this.currentSectionIndex === 0 && this.currentLessonIndex === 0
    const lastSectionIdx = sections.length - 1
    const lastLessonIdx = (sections[lastSectionIdx]?.lessons?.length || 1) - 1
    const isLast = this.currentSectionIndex === lastSectionIdx && this.currentLessonIndex === lastLessonIdx

    // Resolve previous lesson title for breadcrumb
    if (!isFirst) {
      let prevTitle = ''
      if (this.currentLessonIndex > 0) {
        prevTitle = this.currentSection.lessons[this.currentLessonIndex - 1]?.title || ''
      } else if (this.currentSectionIndex > 0) {
        const prevSection = sections[this.currentSectionIndex - 1]
        prevTitle = prevSection.lessons[prevSection.lessons.length - 1]?.title || ''
      }

      const prevBtn = document.createElement('button')
      prevBtn.className = 'vertical-nav-prev'
      prevBtn.setAttribute('aria-label', this.t('nav.previousLesson'))
      prevBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>${escapeHtml(prevTitle || this.t('nav.previousLesson'))}`
      prevBtn.addEventListener('click', () => this.goToPrevLesson())
      container.insertBefore(prevBtn, container.firstChild)
    }

    // Next lesson position (1-based, excluding assessment sections)
    // Determine if the next destination is an assessment section
    const nextIsAssessment = !isLast &&
      this.currentLessonIndex === (this.currentSection?.lessons?.length || 1) - 1 &&
      sections[this.currentSectionIndex + 1]?.isAssessment

    let nextLessonNum = 0
    if (!nextIsAssessment) {
      for (let si = 0; si < sections.length; si++) {
        if (sections[si].isAssessment) continue
        for (let li = 0; li < sections[si].lessons.length; li++) {
          if (this.isConclusionLesson(sections[si].lessons[li]) || this.isCoverLesson(sections[si].lessons[li])) continue  // Skip conclusion/cover lesson
          nextLessonNum++
          if (si === this.currentSectionIndex && li === this.currentLessonIndex) break
        }
        if (si === this.currentSectionIndex) break
      }
      nextLessonNum++ // The card shows "Up Next", so advance by one
    }

    // Show lesson count only for content lessons, not when navigating to assessment
    const progressStr = this.course.settings.showProgress && !nextIsAssessment
      ? this.t('nav.lessonProgress', { current: nextLessonNum, total: this.totalLessons })
      : ''

    // Determine if next lesson is locked
    let nextNavSection = this.currentSectionIndex
    let nextNavLesson = this.currentLessonIndex
    if (this.currentLessonIndex < this.currentSection.lessons.length - 1) {
      nextNavLesson = this.currentLessonIndex + 1
    } else if (this.currentSectionIndex < sections.length - 1) {
      nextNavSection = this.currentSectionIndex + 1
      nextNavLesson = 0
    }
    const nextIsLocked = !this.isLessonAccessible(nextNavSection, nextNavLesson)
    // Completion gate: not hard-locked, but the current lesson isn't finished yet.
    // The card stays clickable so activating it surfaces the explanatory toast.
    const nextIsGated = !nextIsLocked && this.isNextGated()
    const gateHint = nextIsGated ? this.gateHintText(this.currentLesson) : ''

    // Up-next card with lesson title preview
    if (!isLast) {
      let nextTitle = ''
      let nextSectionTitle = ''
      if (this.currentLessonIndex < this.currentSection.lessons.length - 1) {
        nextTitle = this.currentSection.lessons[this.currentLessonIndex + 1]?.title || ''
        nextSectionTitle = this.currentSection.title || ''
      } else if (this.currentSectionIndex < sections.length - 1) {
        const nextSection = sections[this.currentSectionIndex + 1]
        nextTitle = nextSection.lessons[0]?.title || ''
        nextSectionTitle = nextSection.title || ''
      }

      const card = document.createElement('button')
      card.className = `vertical-nav-next-card${nextIsLocked ? ' nav-locked' : ''}${nextIsGated ? ' nav-gated' : ''}`
      card.setAttribute('aria-label', `${this.t('nav.upNext')}: ${nextTitle}`)
      if (nextIsLocked || nextIsGated) {
        card.setAttribute('aria-disabled', 'true')
        card.setAttribute('title', nextIsLocked ? this.t('nav.locked') : gateHint)
      }
      const metaText = nextIsLocked
        ? escapeHtml(this.t('nav.locked'))
        : nextIsGated
          ? escapeHtml(gateHint)
          : `${escapeHtml(nextSectionTitle)}${progressStr ? (nextSectionTitle ? ' · ' : '') + escapeHtml(progressStr) : ''}`
      card.innerHTML = `<div class="vertical-nav-next-card-inner">
        <div class="vertical-nav-next-card-content">
          <div class="vertical-nav-next-label">${escapeHtml(this.t('nav.upNext'))}</div>
          <div class="vertical-nav-next-title">${escapeHtml(nextTitle || this.t('nav.nextLesson'))}</div>
          <div class="vertical-nav-next-meta">${metaText}</div>
        </div>
        <svg class="vertical-nav-next-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </div>`
      if (!nextIsLocked) {
        card.addEventListener('click', () => this.goToNextLesson())
      }
      container.appendChild(card)
    } else {
      // End-of-course card
      const endCard = document.createElement('div')
      endCard.className = 'vertical-end-card'
      const endProgressStr = this.course.settings.showProgress
        ? this.t('nav.lessonProgress', { current: this.totalLessons, total: this.totalLessons })
        : ''
      endCard.innerHTML = `<div class="vertical-end-card-title">${escapeHtml(this.t('nav.courseComplete'))}</div>${endProgressStr ? `<div class="vertical-end-card-meta">${escapeHtml(endProgressStr)}</div>` : ''}`
      container.appendChild(endCard)
    }
  }

  updateProgress() {
    if (!this.course.settings.showProgress) return

    const viewed = this.viewedLessons.size
    const percent = Math.round((viewed / this.totalLessons) * 100)

    const progressFill = document.getElementById('progress-fill')
    const mobileProgressFill = document.getElementById('mobile-progress-fill')
    const progressText = document.getElementById('progress-text')

    if (progressFill) {
      progressFill.style.width = `${percent}%`
    }
    if (mobileProgressFill) {
      mobileProgressFill.style.width = `${percent}%`
    }
    if (progressText) {
      const prevPercent = this.lastDisplayedPercent ?? 0
      this.animateCounter(progressText, prevPercent, percent, 300)

      // Track progress change via xAPI (only when it increases)
      if (percent > prevPercent && this.scorm?.trackProgress) {
        this.scorm.trackProgress(percent)
      }

      this.lastDisplayedPercent = percent
    }

    // Vertical layout progress bar
    const verticalProgressFill = document.getElementById('vertical-progress-fill')
    const verticalProgressBar = document.getElementById('vertical-progress-bar')
    if (verticalProgressFill) {
      verticalProgressFill.style.width = `${percent}%`
    }
    if (verticalProgressBar) {
      verticalProgressBar.setAttribute('aria-valuenow', String(percent))
    }
    // Update lesson position in vertical end card (position is static per-lesson, so only end card needs update on progress change)
    const verticalEndMeta = document.querySelector('.vertical-end-card-meta')
    if (verticalEndMeta) {
      verticalEndMeta.textContent = this.t('nav.lessonProgress', { current: this.totalLessons, total: this.totalLessons })
    }

    // Check completion
    // For assessment courses, only mark complete if assessment is actually passed
    if (this.isComplete()) {
      console.log('[COMPLETION] isComplete() returned true, hasAssessment=' + this.hasAssessment() + ', hasPassedAssessment=' + this.hasPassedAssessment())
      if (this.hasAssessment()) {
        // Only set complete for assessment courses if they've actually passed
        if (this.hasPassedAssessment()) {
          console.log('[COMPLETION] Assessment passed, setting complete with score=' + (this.assessmentState?.attempts?.[this.assessmentState.attempts.length - 1]?.score ?? 0))
          this.setComplete(true, this.assessmentState?.attempts?.[this.assessmentState.attempts.length - 1]?.score ?? 0)
        } else {
          console.log('[COMPLETION] Assessment NOT passed, NOT setting complete')
        }
      } else {
        // For non-assessment courses, mark complete normally
        console.log('[COMPLETION] No assessment, setting complete normally')
        this.setComplete()
      }
    }
  }

  // Animate a number counting up/down
  animateCounter(element, from, to, duration) {
    // Always set final value, even if no animation needed
    if (from === to) {
      element.textContent = this.t('nav.progress', { percent: to })
      return
    }

    const start = performance.now()
    const update = (now) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      // Ease out curve for smooth deceleration
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = Math.round(from + (to - from) * eased)
      element.textContent = this.t('nav.progress', { percent: current })

      if (progress < 1) {
        requestAnimationFrame(update)
      }
    }
    requestAnimationFrame(update)
  }

  isComplete() {
    // For courses with assessments, completion requires passing
    if (this.hasAssessment()) {
      return this.hasPassedAssessment()
    }

    // All lessons viewed (excluding assessment section and conclusion for non-assessment completion)
    const regularLessons = this.course.sections
      .filter(s => !s.isAssessment)
      .flatMap(s => s.lessons)
      .filter(l => !this.isConclusionLesson(l) && !this.isCoverLesson(l))
    const allViewed = regularLessons.every(l => this.viewedLessons.has(l.id))

    // All knowledge checks completed (in regular sections)
    const allKc = regularLessons.flatMap(l =>
      l.blocks.filter(b => b.type === 'knowledge-check')
    )
    const allKcDone = allKc.every(b => this.completedChecks.has(b.id))

    return allViewed && allKcDone
  }

  // Assessment lifecycle methods
  initAssessmentState() {
    if (!this.assessmentState) {
      this.assessmentState = {
        attempts: [],
        currentAttempt: null,
        questionOrder: null,
        isLocked: false
      }
    }
  }

  startAssessment() {
    if (!this.canStartNewAttempt()) {
      if (this.debug) console.warn('Cannot start new assessment attempt - max attempts reached')
      return false
    }

    this.initAssessmentState()

    const questions = this.getAssessmentQuestions()
    const config = this.assessmentConfig

    // Determine question order (randomize if enabled)
    let questionOrder = questions.map(q => q.id)
    if (config?.randomizeQuestions) {
      questionOrder = this.shuffleArray([...questionOrder])
    }

    const attemptNumber = this.getCurrentAttemptNumber()

    // Create new attempt
    const attempt = {
      attemptNumber: attemptNumber,
      startedAt: new Date().toISOString(),
      completedAt: null,
      answers: [],
      score: 0,
      passed: false,
      questionOrder: questionOrder
    }

    this.assessmentState.currentAttempt = attempt
    this.assessmentQuestionOrder = questionOrder
    this.isInAssessment = true

    // Track assessment start via xAPI
    if (this.scorm?.trackAssessmentStart) {
      const assessmentSection = this.course.sections.find(s => s.isAssessment)
      const passingScore = config?.passingScoreType === 'count'
        ? (config.passingScoreCount ?? 1)
        : (config?.passingScorePercentage ?? config?.passingScore ?? 70)

      this.scorm.trackAssessmentStart({
        assessmentTitle: assessmentSection?.title || 'Assessment',
        attemptNumber: attemptNumber,
        totalQuestions: questions.length,
        passingScore: passingScore,
        maxAttempts: config?.maxAttempts || 0
      })
    }

    // Reset completed checks for this attempt (assessment questions only)
    questions.forEach(q => this.completedChecks.delete(q.id))

    this.saveProgress()
    this.renderCurrentLesson()

    return true
  }

  submitAssessmentAnswer(questionId, selectedOptionIds, correct, textResponse) {
    if (!this.assessmentState?.currentAttempt) {
      return
    }

    // Remove existing answer for this question (in case of re-answer)
    const existingIndex = this.assessmentState.currentAttempt.answers.findIndex(
      a => a.questionId === questionId
    )
    if (existingIndex >= 0) {
      this.assessmentState.currentAttempt.answers.splice(existingIndex, 1)
    }

    // Add new answer
    const answer = {
      questionId,
      selectedOptionIds: Array.isArray(selectedOptionIds) ? selectedOptionIds : [selectedOptionIds],
      correct
    }
    if (textResponse !== undefined) {
      answer.textResponse = textResponse
    }
    this.assessmentState.currentAttempt.answers.push(answer)

    this.saveProgress()
  }

  calculateAssessmentScore() {
    const answers = this.assessmentState?.currentAttempt?.answers || []
    const questions = this.getAssessmentQuestions()
    const correct = answers.filter(a => a.correct).length
    const total = questions.length
    const percentage = total > 0 ? Math.round((correct / total) * 100) : 0

    return { correct, total, percentage }
  }

  finishAssessment() {
    if (!this.assessmentState?.currentAttempt) {
      return null
    }

    const config = this.assessmentConfig
    const { correct, total, percentage } = this.calculateAssessmentScore()

    // Determine if passed based on score type
    // Use type-specific fields with fallback to legacy passingScore for backwards compatibility
    let passed = false
    if (config?.passingScoreType === 'count') {
      const requiredCount = config.passingScoreCount ?? config.passingScore ?? 1
      passed = correct >= requiredCount
    } else {
      const requiredPercentage = config?.passingScorePercentage ?? config?.passingScore ?? 70
      passed = percentage >= requiredPercentage
    }

    // Complete the attempt
    this.assessmentState.currentAttempt.completedAt = new Date().toISOString()
    this.assessmentState.currentAttempt.score = percentage
    this.assessmentState.currentAttempt.passed = passed

    // Move to attempts history
    this.assessmentState.attempts.push(this.assessmentState.currentAttempt)
    this.assessmentState.currentAttempt = null
    this.isInAssessment = false

    // Show results screen after submission
    this.assessmentState.showingResults = true

    // If showResults is disabled but conclusion page exists, skip results and show conclusion directly
    if (config?.showResults === false && passed && this.getConclusionLesson()) {
      this.assessmentState.showingResults = false
      this.showingConclusionPage = true
    }

    // Check if locked (failed with no retries)
    if (!passed && !this.canStartNewAttempt()) {
      this.assessmentState.isLocked = true
    }

    this.saveProgress()

    // Re-render sidebar to update assessment/conclusion lock states
    this.renderNavigation()

    // Always report score to SCORM when assessment is completed
    // This ensures the LMS has the latest score even if retries are available
    this.setComplete(passed, percentage)

    // Track assessment pass for Share & Track (only when passed)
    if (passed && this.trackingConfig) {
      this.trackAssessmentPassed()
    }

    // Track assessment completion via xAPI
    if (this.scorm?.trackAssessmentComplete) {
      const assessmentSection = this.course.sections.find(s => s.isAssessment)
      const lastAttempt = this.assessmentState.attempts[this.assessmentState.attempts.length - 1]
      const passingScore = config?.passingScoreType === 'count'
        ? (config.passingScoreCount ?? 1)
        : (config?.passingScorePercentage ?? config?.passingScore ?? 70)

      // Calculate duration
      let durationSeconds = 0
      if (lastAttempt?.startedAt && lastAttempt?.completedAt) {
        durationSeconds = Math.floor((new Date(lastAttempt.completedAt) - new Date(lastAttempt.startedAt)) / 1000)
      }

      // Build question results summary
      const questions = this.getAssessmentQuestions()
      const questionResults = lastAttempt?.answers?.map(answer => {
        const question = questions.find(q => q.id === answer.questionId)
        return {
          questionId: answer.questionId,
          questionText: question?.content?.question?.replace(/<[^>]*>/g, '') || '',
          correct: answer.correct
        }
      }) || []

      this.scorm.trackAssessmentComplete({
        assessmentTitle: assessmentSection?.title || 'Assessment',
        attemptNumber: lastAttempt?.attemptNumber || 1,
        score: percentage,
        passingScore: passingScore,
        passed: passed,
        correctCount: correct,
        totalQuestions: total,
        durationSeconds: durationSeconds,
        questionResults: questionResults
      })
    }

    return { correct, total, percentage, passed }
  }

  retryAssessment() {
    if (!this.canStartNewAttempt()) return false
    // Clear results display flag
    if (this.assessmentState) {
      this.assessmentState.showingResults = false
    }
    return this.startAssessment()
  }

  shuffleArray(array) {
    const shuffled = [...array]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled
  }

  allAssessmentQuestionsAnswered() {
    const questions = this.getAssessmentQuestions()
    const answers = this.assessmentState?.currentAttempt?.answers || []
    return questions.length > 0 && answers.length >= questions.length
  }

  setComplete(passed = true, score = null) {
    if (!this.scorm) return

    // Idempotency guard: skip the LMS round-trip when the would-be-committed
    // state matches what we already sent. updateProgress() is called from
    // ~9 sites (IntersectionObserver, navigation, post-submit re-renders),
    // and once the assessment is passed isComplete() stays true — so without
    // this guard a single pass produces 7+ LMSCommit cycles in SCORM Cloud
    // and risks rate-limit warnings on stricter LMSes.
    const targetStatus = this.hasAssessment()
      ? (passed ? 'passed' : 'failed')
      : 'completed'
    const normalizedScore = (score === null || score === undefined) ? null : Math.round(score)
    const last = this._lastCompleteCommit
    if (last && last.status === targetStatus && last.score === normalizedScore && last.passed === passed) {
      console.log('[setComplete] State unchanged (status=' + targetStatus + ', score=' + normalizedScore + '), skipping LMSCommit')
      return
    }

    const msg = '[setComplete] CALLED - passed=' + passed + ', score=' + score + ', hasAssessment=' + this.hasAssessment()
    console.log(msg)
    const logs = JSON.parse(localStorage.getItem('slate_completion_logs') || '[]')
    logs.push(msg)
    localStorage.setItem('slate_completion_logs', JSON.stringify(logs.slice(-50)))

    // Status and score are set via LMSSetValue which works across all formats:
    // - SCORM 1.2 wrapper: sets cmi.core.lesson_status and cmi.core.score.* directly
    // - SCORM 2004 wrapper: maps cmi.core.lesson_status → cmi.completion_status + cmi.success_status,
    //   and cmi.core.score.* → cmi.score.* (including cmi.score.scaled)
    // - xAPI/cmi5 wrappers: map to xAPI statements

    if (this.hasAssessment()) {
      // Always set score for assessment courses (whether passed or failed)
      this.scorm.LMSSetValue('cmi.core.score.raw', Math.round(score ?? 0).toString())
      this.scorm.LMSSetValue('cmi.core.score.min', '0')
      this.scorm.LMSSetValue('cmi.core.score.max', '100')

      if (passed) {
        const msg3 = '[setComplete] Assessment passed, setting status to passed'
        console.log(msg3)
        logs.push(msg3)
        this.scorm.LMSSetValue('cmi.core.lesson_status', 'passed')
      } else {
        const msg2 = '[setComplete] Assessment failed, setting status to failed'
        console.log(msg2)
        logs.push(msg2)
        this.scorm.LMSSetValue('cmi.core.lesson_status', 'failed')
      }
    } else {
      // Completion-only course (no score needed)
      const msg4 = '[setComplete] Non-assessment course, setting status to completed'
      console.log(msg4)
      logs.push(msg4)
      if (score !== null) {
        this.scorm.LMSSetValue('cmi.core.score.raw', Math.round(score).toString())
        this.scorm.LMSSetValue('cmi.core.score.min', '0')
        this.scorm.LMSSetValue('cmi.core.score.max', '100')
      }
      this.scorm.LMSSetValue('cmi.core.lesson_status', 'completed')
    }
    const msg5 = '[setComplete] Calling LMSCommit'
    console.log(msg5)
    logs.push(msg5)
    localStorage.setItem('slate_completion_logs', JSON.stringify(logs.slice(-50)))
    this.scorm.LMSCommit('')

    this._lastCompleteCommit = { status: targetStatus, score: normalizedScore, passed }
  }

  /**
   * Record a question interaction to SCORM
   * Tracks individual question responses for learning analytics
   *
   * @param {Object} params - Interaction parameters
   * @param {string} params.id - Unique question/block ID
   * @param {string} params.type - Question type: 'choice' (single), 'multiple-choice' (multi-select)
   * @param {string} params.question - The question text
   * @param {Array} params.options - Available answer options [{id, text, correct}]
   * @param {Array} params.selectedIds - IDs of selected options
   * @param {boolean} params.correct - Whether the answer was correct
   * @param {number} params.latency - Time spent on question in seconds (optional)
   */
  recordInteraction({ id, question, options, selectedIds, correct, latency }) {
    if (!this.scorm) return

    const n = this.interactionCount
    const prefix = `cmi.interactions.${n}`

    // Build a map of option ID to readable identifier
    // Format: "Answer_Text_shortid" - text with underscores + short hash for uniqueness
    const optionMap = {}
    options.forEach((opt) => {
      const text = opt.text.replace(/<[^>]*>/g, '').trim()
      const safeText = text.substring(0, 30).replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '')
      const shortId = opt.id.substring(0, 8)
      optionMap[opt.id] = `${safeText}_${shortId}`
    })

    // Interaction ID (unique identifier for this question)
    this.scorm.LMSSetValue(`${prefix}.id`, id)

    // Interaction type
    this.scorm.LMSSetValue(`${prefix}.type`, 'choice')

    // Timestamp - SCORM 2004 format: YYYY-MM-DDTHH:MM:SS (no milliseconds, no Z)
    const now = new Date()
    const timestamp = now.toISOString().replace(/\.\d{3}Z$/, '')
    this.scorm.LMSSetValue(`${prefix}.timestamp`, timestamp)

    // Description - question text only (answer text is now in the response identifier)
    if (question) {
      const plainQuestion = question.replace(/<[^>]*>/g, '').trim().substring(0, 250)
      this.scorm.LMSSetValue(`${prefix}.description`, plainQuestion)
    }

    // Learner response - readable identifier with answer text
    if (selectedIds && selectedIds.length > 0) {
      const responses = selectedIds.map(id => optionMap[id] || id)
      this.scorm.LMSSetValue(`${prefix}.learner_response`, responses.join('[,]'))
    }

    // Correct response pattern - readable identifier with answer text
    const correctIds = options
      .filter(o => o.correct === true || o.correct === 'true')
      .map(o => o.id)
    if (correctIds.length > 0) {
      const correctResponses = correctIds.map(id => optionMap[id] || id)
      this.scorm.LMSSetValue(`${prefix}.correct_responses.0.pattern`, correctResponses.join('[,]'))
    }

    // Result
    this.scorm.LMSSetValue(`${prefix}.result`, correct ? 'correct' : 'incorrect')

    // Latency (time spent) - ISO 8601 duration format
    if (latency !== undefined && latency > 0) {
      const hours = Math.floor(latency / 3600)
      const minutes = Math.floor((latency % 3600) / 60)
      const seconds = latency % 60
      let latencyStr = 'PT'
      if (hours > 0) latencyStr += `${hours}H`
      if (minutes > 0) latencyStr += `${minutes}M`
      latencyStr += `${seconds.toFixed(2)}S`
      this.scorm.LMSSetValue(`${prefix}.latency`, latencyStr)
    }

    // Weighting
    this.scorm.LMSSetValue(`${prefix}.weighting`, '1')

    this.interactionCount++
    this.scorm.LMSCommit('')
  }

  checkFibCorrectness(userAnswer, acceptedAnswers, caseSensitive) {
    const trimmed = userAnswer.trim()
    return acceptedAnswers.some(accepted => {
      const acceptedTrimmed = accepted.trim()
      if (caseSensitive) return trimmed === acceptedTrimmed
      return trimmed.toLowerCase() === acceptedTrimmed.toLowerCase()
    })
  }

  recordFibInteraction({ id, question, userAnswer, acceptedAnswers, correct }) {
    if (!this.scorm) return

    const n = this.interactionCount
    const prefix = `cmi.interactions.${n}`

    this.scorm.LMSSetValue(`${prefix}.id`, id)
    this.scorm.LMSSetValue(`${prefix}.type`, 'fill-in')

    const now = new Date()
    const timestamp = now.toISOString().replace(/\.\d{3}Z$/, '')
    this.scorm.LMSSetValue(`${prefix}.timestamp`, timestamp)

    if (question) {
      const plainQuestion = question.replace(/<[^>]*>/g, '').trim().substring(0, 250)
      this.scorm.LMSSetValue(`${prefix}.description`, plainQuestion)
    }

    // Learner response
    const safeResponse = userAnswer.substring(0, 250).replace(/[{}]/g, '')
    this.scorm.LMSSetValue(`${prefix}.learner_response`, safeResponse)

    // Correct response pattern (first accepted answer)
    if (acceptedAnswers.length > 0) {
      const safeCorrect = acceptedAnswers[0].substring(0, 250).replace(/[{}]/g, '')
      this.scorm.LMSSetValue(`${prefix}.correct_responses.0.pattern`, safeCorrect)
    }

    this.scorm.LMSSetValue(`${prefix}.result`, correct ? 'correct' : 'incorrect')
    this.scorm.LMSSetValue(`${prefix}.weighting`, '1')

    this.interactionCount++
    this.scorm.LMSCommit('')
  }

  // ============================================
  // PROGRESS PERSISTENCE
  // ============================================

  saveProgress() {
    const data = {
      currentSection: this.currentSectionIndex,
      currentLesson: this.currentLessonIndex,
      viewedLessons: Array.from(this.viewedLessons),
      completedChecks: Array.from(this.completedChecks),
      lessonsReachedEnd: Array.from(this.lessonsReachedEnd),
      completedInteractions: Array.from(this.completedInteractions),
      knowledgeCheckAttempts: this.knowledgeCheckAttempts || {},
      assessmentState: this.assessmentState,
      isInAssessment: this.isInAssessment,
      assessmentQuestionOrder: this.assessmentQuestionOrder,
      conclusionViewed: this.conclusionViewed || false,
      showingConclusionPage: this.showingConclusionPage || false,
      coverViewed: this.coverViewed || false,
      showingCoverPage: this.showingCoverPage || false,
      lessonPacingElapsed: Object.fromEntries(this.lessonPacingElapsed)
    }

    if (this.scorm) {
      this.scorm.LMSSetValue('cmi.suspend_data', JSON.stringify(data))
      this.scorm.LMSCommit('')
    }
  }

  loadProgress() {
    if (this.scorm) {
      const data = this.scorm.LMSGetValue('cmi.suspend_data')
      if (data) {
        try {
          const parsed = JSON.parse(data)
          this.currentSectionIndex = parsed.currentSection || 0
          this.currentLessonIndex = parsed.currentLesson || 0
          this.viewedLessons = new Set(parsed.viewedLessons || [])
          this.completedChecks = new Set(parsed.completedChecks || [])
          this.lessonsReachedEnd = new Set(parsed.lessonsReachedEnd || [])
          this.completedInteractions = new Set(parsed.completedInteractions || [])
          this.knowledgeCheckAttempts = parsed.knowledgeCheckAttempts || {}
          // Restore assessment state
          this.assessmentState = parsed.assessmentState || null
          this.isInAssessment = parsed.isInAssessment || false
          this.assessmentQuestionOrder = parsed.assessmentQuestionOrder || []
          // Restore conclusion page state
          this.conclusionViewed = parsed.conclusionViewed || false
          this.showingConclusionPage = parsed.showingConclusionPage || false
          // Restore cover page state
          this.coverViewed = parsed.coverViewed || false
          this.showingCoverPage = parsed.showingCoverPage || false
          // Restore Lesson Pacing accrued time (object -> Map; absent on legacy data)
          this.lessonPacingElapsed = new Map(Object.entries(parsed.lessonPacingElapsed || {}))
        } catch (e) {
          // Could not parse suspend data, starting fresh
        }
      }
    }
  }
}

// Initialize player
const player = new SlatePlayer()
player.init()
