import React, { useState, useEffect, useRef, useCallback } from 'react'
import Orb from './Orb'
import { RealtimeRPCClient } from '../rpc/realtime'
import { VoiceNotificationCenter, type VoiceNotification } from './VoiceNotificationCenter'
import { useUiConfig } from '../ui-config'

/**
 * Orb visual states for voice interaction
 * Each state has distinct visual characteristics (scale, animation speed, turbulence)
 * to create a Pixar-like "alive" feeling
 */
enum OrbState {
  IDLE = 'idle',           // Muted, "sleeping but aware" - subtle breathing pulse
  LISTENING = 'listening', // Unmuted, attentive - audio-reactive, larger presence
  THINKING = 'thinking',   // Processing response - fast pulse, turbulent, energetic
  SPEAKING = 'speaking',   // Playing back audio - expressive, large, dynamic
}

export function VoiceModal({ isOpen, onClose, sessionId, onSessionCreated }: { isOpen: boolean; onClose: () => void; sessionId?: string; onSessionCreated?: (id: string) => void }) {
  const { debug, wsRealtimeUrl, token } = useUiConfig()
  const [isMuted, setIsMuted] = useState(true)
  const [audioLevel, setAudioLevel] = useState(0)
  const [orbState, setOrbState] = useState<OrbState>(OrbState.IDLE)
  const [isActuallyPlayingAudio, setIsActuallyPlayingAudio] = useState(false)
  const [isUsingTool, setIsUsingTool] = useState(false)  // Tool use is an overlay, not a state
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyzerRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const smoothedAudioLevelRef = useRef<number>(0)  // For smoothing audio level changes
  const processorRef = useRef<AudioWorkletNode | null>(null)
  const resampleBufferRef = useRef<Float32Array | null>(null)
  const bufferQueueRef = useRef<{ chunks: Float32Array[]; length: number }>({ chunks: [], length: 0 })
  const clientRef = useRef<RealtimeRPCClient | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const scheduledTimeRef = useRef<number>(0)
  const isMutedRef = useRef<boolean>(true)
  const duplexHoldRef = useRef<boolean>(false)
  const micDisabledByPlaybackRef = useRef<boolean>(false)
  const debugEnabled = debug
  const workletUrlRef = useRef<string | null>(null)
  const animationRafRef = useRef<number | null>(null)
  const [, forceUpdate] = useState({})
  const [notifications, setNotifications] = useState<VoiceNotification[]>([])
  const activeAudioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())
  const playbackCheckIntervalRef = useRef<number | null>(null)
  const toolUseEndTimeRef = useRef<number>(0)  // When the last tool finished
  const toolUseLingerMs = 1800  // How long the effect lingers after tool completes (1.8s)

  // Track actual audio playback state by checking audio context time vs scheduled time
  useEffect(() => {
    if (!isOpen) return

    const checkPlayback = () => {
      const ctx = audioContextRef.current
      if (ctx && scheduledTimeRef.current > 0) {
        const isPlaying = ctx.currentTime < scheduledTimeRef.current
        setIsActuallyPlayingAudio(isPlaying)
        if (!isPlaying && activeAudioSourcesRef.current.size === 0) {
          // All audio finished playing
          scheduledTimeRef.current = 0
        }
      } else {
        setIsActuallyPlayingAudio(false)
      }
    }

    // Check playback state every 50ms
    playbackCheckIntervalRef.current = window.setInterval(checkPlayback, 50)

    return () => {
      if (playbackCheckIntervalRef.current) {
        clearInterval(playbackCheckIntervalRef.current)
      }
    }
  }, [debugEnabled, isOpen, onSessionCreated, sessionId, token, wsRealtimeUrl])

  // Animation loop for breathing pulse effects
  useEffect(() => {
    if (!isOpen) return

    const animate = () => {
      // Force re-render for time-based animations in IDLE, THINKING states, or when tool overlay is active
      if (orbState === OrbState.IDLE ||
          orbState === OrbState.THINKING ||
          isUsingTool) {
        forceUpdate({})
      }
      animationRafRef.current = requestAnimationFrame(animate)
    }

    animationRafRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRafRef.current) {
        cancelAnimationFrame(animationRafRef.current)
      }
    }
  }, [isOpen, orbState, isUsingTool])

  // Monitor tool linger expiration and turn off overlay when done
  useEffect(() => {
    if (!isOpen || !isUsingTool) return

    if (debugEnabled) console.log('[VoiceModal] Setting up tool linger interval')

    const checkExpiration = () => {
      // Only check if we're in linger mode (toolUseEndTimeRef.current > 0 means linger started)
      if (toolUseEndTimeRef.current > 0) {
        const timeSinceEnd = Date.now() - toolUseEndTimeRef.current
        if (debugEnabled) console.log('[VoiceModal] Checking linger expiration:', { timeSinceEnd, threshold: toolUseLingerMs })
        if (timeSinceEnd >= toolUseLingerMs) {
          console.log('[VoiceModal] Tool linger expired, disabling overlay')
          setIsUsingTool(false)
          toolUseEndTimeRef.current = 0
        }
      }
    }

    // Check every 100ms if linger period has expired
    const interval = setInterval(checkExpiration, 100)
    return () => {
      if (debugEnabled) console.log('[VoiceModal] Clearing tool linger interval')
      clearInterval(interval)
    }
  }, [isOpen, isUsingTool])

  useEffect(() => {
    if (!isOpen) return

    let mounted = true
    isMutedRef.current = true

    // Check if mediaDevices is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('getUserMedia not supported in this browser')
      return
    }

    // Request microphone access
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      } as any,
    })
      .then(async stream => {
        if (!mounted) {
          stream.getTracks().forEach(track => track.stop())
          return
        }

        streamRef.current = stream
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
        audioContextRef.current = audioContext
        if (debugEnabled) console.log('[ui] audio ctx', { sampleRate: audioContext.sampleRate })

        const analyzer = audioContext.createAnalyser()
        analyzer.fftSize = 256
        analyzerRef.current = analyzer

        const source = audioContext.createMediaStreamSource(stream)
        source.connect(analyzer)

        // Build and load AudioWorklet module (inline to avoid bundling issues)
        const workletCode = `
          class OmniAudioCapture extends AudioWorkletProcessor {
            process(inputs, outputs) {
              const input = inputs[0];
              if (!input || input.length === 0) return true;
              const channel = input[0];
              if (!channel) return true;
              // Forward to main thread for encoding
              this.port.postMessage(channel);
              // Keep graph active by passing through to an output
              if (outputs && outputs.length && outputs[0] && outputs[0][0]) {
                outputs[0][0].set(channel);
              }
              return true;
            }
          }
          registerProcessor('omni-audio-capture', OmniAudioCapture);
        `
        const blob = new Blob([workletCode], { type: 'application/javascript' })
        const workletUrl = URL.createObjectURL(blob)
        try {
          await audioContext.audioWorklet.addModule(workletUrl)
          workletUrlRef.current = workletUrl
          const node = new AudioWorkletNode(audioContext, 'omni-audio-capture', { numberOfInputs: 1, numberOfOutputs: 1 })
          processorRef.current = node
          source.connect(node)
          const sink = audioContext.createGain()
          sink.gain.value = 0
          node.connect(sink)
          sink.connect(audioContext.destination)
          const onAudioFloats = (inFloats: Float32Array) => {
            if (!mounted) return
            if (isMutedRef.current) return
            if (duplexHoldRef.current) return
            const res = resampleTo24k(inFloats, audioContext.sampleRate)
            const q = bufferQueueRef.current
            q.chunks.push(res)
            q.length += res.length
            const chunkSize = 2400
            while (q.length >= chunkSize) {
              const out = new Float32Array(chunkSize)
              let offset = 0
              while (offset < chunkSize && q.chunks.length) {
                const head = q.chunks[0]
                const take = Math.min(head.length, chunkSize - offset)
                out.set(head.subarray(0, take), offset)
                offset += take
                if (take === head.length) {
                  q.chunks.shift()
                } else {
                  q.chunks[0] = head.subarray(take)
                }
              }
              q.length -= chunkSize
              encodeAndSend(out)
            }
          }

          node.port.onmessage = (ev: MessageEvent) => {
            onAudioFloats(ev.data as Float32Array)
          }
        } catch (e) {
          // Fallback to ScriptProcessorNode for browsers without AudioWorklet
          const proc = audioContext.createScriptProcessor(4096, 1, 1)
          // @ts-ignore
          processorRef.current = proc as any
          source.connect(proc)
          const sink = audioContext.createGain()
          sink.gain.value = 0
          proc.connect(sink)
          sink.connect(audioContext.destination)
          proc.onaudioprocess = (ev: AudioProcessingEvent) => {
            if (!mounted) return
            if (isMutedRef.current) return
            if (duplexHoldRef.current) return
            const inBuf = ev.inputBuffer.getChannelData(0)
            const res = resampleTo24k(inBuf, audioContext.sampleRate)
            const q = bufferQueueRef.current
            q.chunks.push(res)
            q.length += res.length
            const chunkSize = 2400
            while (q.length >= chunkSize) {
              const out = new Float32Array(chunkSize)
              let offset = 0
              while (offset < chunkSize && q.chunks.length) {
                const head = q.chunks[0]
                const take = Math.min(head.length, chunkSize - offset)
                out.set(head.subarray(0, take), offset)
                offset += take
                if (take === head.length) {
                  q.chunks.shift()
                } else {
                  q.chunks[0] = head.subarray(take)
                }
              }
              q.length -= chunkSize
              encodeAndSend(out)
            }
          }
        }

        const floatTo16 = (input: Float32Array) => {
          const out = new Int16Array(input.length)
          for (let i = 0; i < input.length; i++) {
            let s = input[i]
            if (s < -1) s = -1
            if (s > 1) s = 1
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
          }
          return new Uint8Array(out.buffer)
        }

        const resampleTo24k = (input: Float32Array, inRate: number) => {
          const ratio = 24000 / inRate
          const outLen = Math.floor(input.length * ratio)
          const out = new Float32Array(outLen)
          for (let i = 0; i < outLen; i++) {
            const pos = i / ratio
            const idx = Math.floor(pos)
            const frac = pos - idx
            const s0 = input[idx] || 0
            const s1 = input[idx + 1] || 0
            out[i] = s0 + (s1 - s0) * frac
          }
          return out
        }

        const encodeAndSend = async (floats: Float32Array, commit: boolean = false) => {
          if (!clientRef.current || !sessionIdRef.current) return
          const bytes = floatTo16(floats)

          // Convert bytes to binary string efficiently using chunking to avoid stack overflow
          const chunkSize = 8192
          let binary = ''
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
            binary += String.fromCharCode.apply(null, Array.from(chunk))
          }

          const b64 = btoa(binary)
          try {
            if (debugEnabled) console.log('[ui] send audio', { samples: floats.length, bytes: bytes.length, b64: b64.length, commit })
            await clientRef.current.sendAudio(sessionIdRef.current, b64, commit)
          } catch (error) {
            console.error('Failed to send audio:', error)
          }
        }

        const dataArray = new Uint8Array(analyzer.frequencyBinCount)

        // Weighted audio level calculation that emphasizes voice frequencies
        const calculateWeightedAudioLevel = (data: Uint8Array): number => {
          const len = data.length
          const bassThird = Math.floor(len / 3)
          const midThird = Math.floor(len * 2 / 3)

          let bassSum = 0
          let midSum = 0
          let highSum = 0

          for (let i = 0; i < bassThird; i++) bassSum += data[i] * 2.0  // Weight bass more
          for (let i = bassThird; i < midThird; i++) midSum += data[i] * 1.5  // Voice range
          for (let i = midThird; i < len; i++) highSum += data[i] * 0.8  // De-emphasize high

          const weighted = (bassSum + midSum + highSum) / (len * 1.5)  // Normalize
          return Math.min(weighted / 128, 1)
        }

        const updateAudioLevel = () => {
          if (!mounted || !analyzerRef.current) return

          analyzer.getByteFrequencyData(dataArray)
          const normalized = calculateWeightedAudioLevel(dataArray)

          // Apply exponential smoothing to reduce jitter
          // Smoothing factor: 0.15 = smooth (slower response), 0.5 = reactive (faster response)
          const smoothing = 0.2
          smoothedAudioLevelRef.current = smoothedAudioLevelRef.current * (1 - smoothing) + normalized * smoothing

          // Only update state if change is significant (reduces unnecessary re-renders)
          const threshold = 0.02  // 2% change threshold
          if (Math.abs(smoothedAudioLevelRef.current - audioLevel) > threshold) {
            setAudioLevel(smoothedAudioLevelRef.current)
          }

          rafRef.current = requestAnimationFrame(updateAudioLevel)
        }

        updateAudioLevel()
      })
      .catch(err => {
        console.error('Audio setup error:', err)
      })

    return () => {
      mounted = false
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }
      if (processorRef.current) {
        try { processorRef.current.disconnect() } catch {}
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
      if (workletUrlRef.current) {
        try { URL.revokeObjectURL(workletUrlRef.current) } catch {}
        workletUrlRef.current = null
      }
    }
  }, [isOpen])

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !isMuted
      })
    }
  }, [isMuted])

  useEffect(() => {
    if (!isOpen) return

    // Initialize to idle state when modal opens
    setOrbState(OrbState.IDLE)

    const client = new RealtimeRPCClient(wsRealtimeUrl, token, debugEnabled)
    if (debugEnabled) console.log('[ui] VoiceModal init', { base: wsRealtimeUrl, token, debug: debugEnabled })
    clientRef.current = client
    let active = true
    const onEvent = client.on('realtime_event', (p: any) => {
      const t = String(p?.type || '')
      if (debugEnabled) console.log('[ui] event', t, p)

      // State machine transitions based on realtime events:
      // IDLE → LISTENING (user unmutes)
      // LISTENING → THINKING (agent starts response)
      // THINKING → SPEAKING (first audio chunk arrives)
      // SPEAKING → LISTENING (audio ends)
      // * → IDLE (user mutes or interrupts)
      //
      // Tool use is an overlay (not a state) that can combine with any state:
      // - Tool overlay activates when realtime_tool_start received
      // - Tool overlay lingers for 1.8s after realtime_tool_end
      // - Can be active during THINKING, SPEAKING, LISTENING, or IDLE

      if (t === 'realtime_response_start') {
        setOrbState(OrbState.THINKING)
      }

      if (t === 'realtime_tool_start') {
        setIsUsingTool(true)
        toolUseEndTimeRef.current = 0  // Reset end time - new tool starting
      }

      if (t === 'realtime_tool_end') {
        // Don't immediately turn off - start the linger countdown
        toolUseEndTimeRef.current = Date.now()
        // Tool overlay will fade out automatically after linger period
      }

      // Agent events forwarded from the bridge channel
      if (t === 'agent_event') {
        const eventType = String(p?.event_type || '')
        const data = p?.data || {}

        if (eventType === 'tool_called') {
          setIsUsingTool(true)
          toolUseEndTimeRef.current = 0
          setNotifications(prev => [{
            id: `tc_${data.call_id || Date.now()}`,
            type: 'tool_called' as const,
            tool: data.tool || 'tool',
            input: typeof data.input === 'string' ? data.input : JSON.stringify(data.input),
            call_id: data.call_id,
            timestamp: Date.now(),
          }, ...prev].slice(0, 10))
        }

        if (eventType === 'tool_result') {
          toolUseEndTimeRef.current = Date.now()
          setNotifications(prev => {
            const idx = prev.findIndex(n => n.call_id === data.call_id && n.type === 'tool_called')
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], type: 'tool_result', output: typeof data.output === 'string' ? data.output : JSON.stringify(data.output), metadata: data.metadata, timestamp: Date.now() }
              return next
            }
            return [{ id: `tr_${data.call_id || Date.now()}`, type: 'tool_result' as const, tool: data.tool || 'tool', output: typeof data.output === 'string' ? data.output : JSON.stringify(data.output), call_id: data.call_id, metadata: data.metadata, timestamp: Date.now() }, ...prev].slice(0, 10)
          })
        }

        if (eventType === 'client_request') {
          const fn = String(data?.function || '')
          if (fn === 'ui.request_tool_approval') {
            const args = data?.args || {}
            setNotifications(prev => [{
              id: `ap_${data.request_id || Date.now()}`,
              type: 'tool_approval' as const,
              tool: args.tool || 'tool',
              input: typeof args.arguments === 'string' ? args.arguments : JSON.stringify(args.arguments),
              request_id: data.request_id,
              metadata: args.metadata,
              timestamp: Date.now(),
            }, ...prev].slice(0, 10))
          }
        }

        if (eventType === 'client_request_resolved') {
          const reqId = String(data?.request_id || '')
          if (reqId) {
            setNotifications(prev => prev.filter(n => n.request_id !== reqId))
          }
        }
      }

      if (t === 'realtime_response_start' || t === 'realtime_audio') {
        duplexHoldRef.current = true
        try {
          const tracks = streamRef.current?.getAudioTracks() || []
          tracks.forEach(tr => { if (tr.enabled) { tr.enabled = false; micDisabledByPlaybackRef.current = true } })
        } catch {}
      }
      if (t === 'realtime_audio') {
        // Don't set SPEAKING state here - let actual playback drive it
        const b64 = String(p?.audio_base64 || '')
        if (!b64) return
        try {
          const bin = atob(b64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const view = new DataView(bytes.buffer)
          const samples = new Float32Array(bytes.length / 2)
          for (let i = 0; i < samples.length; i++) {
            const s = view.getInt16(i * 2, true)
            samples[i] = s / 0x8000
          }
          const ctx = audioContextRef.current
          if (!ctx) return
          try { ctx.resume().catch(() => {}) } catch {}
          const buffer = ctx.createBuffer(1, samples.length, 24000)
          buffer.getChannelData(0).set(samples)
          const src = ctx.createBufferSource()
          src.buffer = buffer
          const startAt = Math.max(ctx.currentTime, scheduledTimeRef.current)

          // Track this audio source
          activeAudioSourcesRef.current.add(src)

          // Remove from tracking when it ends
          src.onended = () => {
            activeAudioSourcesRef.current.delete(src)
          }

          src.connect(ctx.destination)
          try { src.start(startAt) } catch {}
          scheduledTimeRef.current = startAt + buffer.duration
          if (debugEnabled) console.log('[ui] play audio', { bytes: bytes.length, samples: samples.length, startAt, scheduledEnd: scheduledTimeRef.current })
        } catch {}
      }
      if (t === 'realtime_audio_end') {
        // Agent finished sending audio chunks, but playback may still be ongoing
        // Don't change state here - let actual playback completion handle it
        setTimeout(() => {
          duplexHoldRef.current = false
          try {
            const tracks = streamRef.current?.getAudioTracks() || []
            if (micDisabledByPlaybackRef.current) {
              tracks.forEach(tr => { tr.enabled = true })
              micDisabledByPlaybackRef.current = false
            }
          } catch {}
        }, 150)
      }

      if (t === 'realtime_audio_interrupted') {
        // Interrupted - stop all audio sources immediately
        activeAudioSourcesRef.current.forEach(src => {
          try { src.stop() } catch {}
        })
        activeAudioSourcesRef.current.clear()
        scheduledTimeRef.current = 0
        setIsActuallyPlayingAudio(false)
        setOrbState(isMutedRef.current ? OrbState.IDLE : OrbState.LISTENING)
        duplexHoldRef.current = false
      }
    })
    client.connect()
      .then(async () => {
        if (!active) return
        try {
          const res = await client.startSession(sessionId)
          const newSid = String(res?.session_id || '')
          sessionIdRef.current = newSid
          if (!sessionId && newSid && onSessionCreated) onSessionCreated(newSid)
          if (debugEnabled) console.log('[ui] session started', res)
        } catch {}
      })
      .catch((e) => { if (debugEnabled) console.error('[ui] connect failed', e) })
    return () => {
      active = false
      onEvent()
      const sid = sessionIdRef.current
      if (debugEnabled) console.log('[ui] cleanup', { sid })
      if (sid && clientRef.current) clientRef.current.stopSession(sid).catch(() => {})
      client.disconnect()
      clientRef.current = null
      sessionIdRef.current = null
      scheduledTimeRef.current = 0
      toolUseEndTimeRef.current = 0  // Clear tool linger state
      // Stop all audio sources
      activeAudioSourcesRef.current.forEach(src => {
        try { src.stop() } catch {}
      })
      activeAudioSourcesRef.current.clear()
      setIsActuallyPlayingAudio(false)
      setNotifications([])
    }
  }, [isOpen])

  const handleApprove = useCallback((requestId: string) => {
    clientRef.current?.clientResponse(requestId, true, { approved: true })
    setNotifications(prev => prev.filter(n => n.request_id !== requestId))
  }, [])

  const handleReject = useCallback((requestId: string) => {
    clientRef.current?.clientResponse(requestId, true, { approved: false })
    setNotifications(prev => prev.filter(n => n.request_id !== requestId))
  }, [])

  const handleDismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }, [])

  if (!isOpen) return null

  // Tool overlay is controlled entirely by isUsingTool state
  // The useEffect will automatically turn it off after 1.8s linger period
  const toolOverlayActive = isUsingTool

  // Determine base state by combining agent state with actual playback
  // Priority: actual audio playback > agent execution state
  let effectiveState = orbState

  if (debugEnabled) {
    console.log('[VoiceModal State]', {
      orbState,
      isActuallyPlayingAudio,
      isUsingTool,
      toolOverlayActive,
      toolUseEndTime: toolUseEndTimeRef.current,
    })
  }

  // Handle SPEAKING state (audio playback)
  if (isActuallyPlayingAudio) {
    // Override to SPEAKING when audio is actually playing
    effectiveState = OrbState.SPEAKING
    if (debugEnabled) console.log('[VoiceModal] → SPEAKING (audio playing)')
  } else if (orbState === OrbState.SPEAKING) {
    // Audio finished but state hasn't updated yet - transition back
    const shouldBeIdle = isMutedRef.current
    effectiveState = shouldBeIdle ? OrbState.IDLE : OrbState.LISTENING
    // Update the actual state to match
    if (orbState !== effectiveState) {
      if (debugEnabled) console.log('[VoiceModal] SPEAKING finished, transition to', effectiveState)
      setOrbState(effectiveState)
    }
  }

  if (debugEnabled) {
    console.log('[VoiceModal] Base State:', effectiveState, '| Tool Overlay:', toolOverlayActive ? 'ON' : 'OFF')
  }

  // Calculate orb parameters based on state and audio level
  // Add breathing effect for idle state using time-based sine wave
  const breathingPulse = Math.sin(Date.now() / 1500) * 0.02 + 1.0  // Slow 3s cycle, ±2%

  let scale = 1.0
  let noiseAmplitude = 0.5
  let noiseScale = 0.35
  let innerRadius = 0.2
  let hoverIntensity = 0
  let rotateOnHover = true
  let forceHoverState = false
  let animationSpeed = 1.0
  let hue = 0

  switch (effectiveState) {
    case OrbState.IDLE:
      // Sleeping but aware - subtle breathing
      scale = 0.5 * breathingPulse
      noiseAmplitude = 0.5 * breathingPulse
      noiseScale = 0.35
      innerRadius = 0.2
      hoverIntensity = 0
      animationSpeed = 0.8
      forceHoverState = false
      break

    case OrbState.LISTENING:
      // Alert and attentive - moderate baseline + subtle audio reactivity
      scale = Math.min(0.65 + audioLevel * 0.35, 1.0)  // Less dramatic scaling
      noiseAmplitude = Math.min(0.4 + audioLevel * 0.2, 0.6)  // Cap at 0.6 instead of 1.0
      noiseScale = 0.35
      innerRadius = 0.2
      hoverIntensity = Math.min(audioLevel * 1.5, 0.1)  // Reduce distortion
      animationSpeed = 0.9 + audioLevel * 0.3  // Slower base, less reactive (0.9 to 1.2)
      forceHoverState = true
      break

    case OrbState.THINKING:
      // Processing - faster pulse, more turbulent
      const thinkingPulse = Math.sin(Date.now() / 750) * 0.1 + 1.0  // Faster 1.5s cycle
      scale = 0.85 * thinkingPulse
      noiseAmplitude = 0.7
      noiseScale = 0.5  // More turbulent
      innerRadius = 0.15  // More energetic core
      hoverIntensity = 0.1
      animationSpeed = 2.0  // Faster animation
      forceHoverState = true
      break

    case OrbState.SPEAKING:
      // Expressive and alive - large and dynamic
      scale = Math.min(0.9 + audioLevel * 0.6, 1.4)
      noiseAmplitude = Math.min(0.75 + audioLevel * 0.25, 0.95)
      noiseScale = 0.4
      innerRadius = 0.18
      hoverIntensity = 0.12
      animationSpeed = 1.3
      forceHoverState = true
      break
  }

  // Apply tool use overlay effect on top of base state
  // Tool use is additive/multiplicative - it enhances whatever state we're in
  if (toolOverlayActive) {
    const time = Date.now()

    // Rainbow color cycling - like prismatic spell casting through elements
    // Cycles through full spectrum: purple -> blue -> cyan -> green -> yellow -> red -> purple
    const hueCycle = (time / 8) % 360  // Complete cycle every 2.88 seconds
    hue = hueCycle  // Override hue with rainbow cycling

    // Primary pulsing - expansion/contraction like breathing magical energy
    const mainPulse = Math.sin(time / 450) * 0.18 + 1.0

    // Core pulsing - contracts/expands like gathering power into focal point
    const corePulse = Math.sin(time / 700) * 0.04 + 0.14  // Ranges 0.10 to 0.18

    // Secondary pulse for turbulence - creates "crackling energy" effect
    const turbulencePulse = Math.sin(time / 300) * 0.15 + 0.85

    // Modify base state parameters with tool effects (full power, no fade)
    scale *= mainPulse  // Add pulsing to base scale
    noiseAmplitude *= turbulencePulse * 1.3  // Increase turbulence by 30%
    noiseScale = Math.max(noiseScale, 0.6)  // Increase frequency for more chaotic energy
    innerRadius = Math.min(innerRadius, corePulse)  // Contract core for gathering energy effect
    hoverIntensity += 0.15  // Add reality distortion
    animationSpeed *= 3.0  // Speed up animation significantly
    forceHoverState = true  // Always show hover effects during tool use

    if (debugEnabled) {
      console.log('[VoiceModal Tool Overlay]', {
        mainPulse: mainPulse.toFixed(3),
        corePulse: corePulse.toFixed(3),
        turbulencePulse: turbulencePulse.toFixed(3),
        hueCycle: hueCycle.toFixed(0),
        modifiedScale: scale.toFixed(3),
        modifiedNoiseAmplitude: noiseAmplitude.toFixed(3),
        modifiedAnimationSpeed: animationSpeed.toFixed(2),
      })
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center">
      {/* Notification center */}
      <VoiceNotificationCenter
        notifications={notifications}
        onApprove={handleApprove}
        onReject={handleReject}
        onDismiss={handleDismissNotification}
      />

      {/* Center orb */}
      <div className="flex-1 flex items-center justify-center w-full max-w-2xl px-8">
        <div
          className="w-full h-full max-h-[500px] transition-transform duration-300 ease-out"
          style={{ transform: `scale(${scale})` }}
        >
          <Orb
            hue={hue}
            hoverIntensity={hoverIntensity}
            rotateOnHover={rotateOnHover}
            forceHoverState={forceHoverState}
            noiseAmplitude={noiseAmplitude}
            noiseScale={noiseScale}
            innerRadius={innerRadius}
            animationSpeed={animationSpeed}
          />
        </div>
      </div>

      {/* Bottom controls */}
      <div className="pb-12 flex flex-col items-center gap-4">
        {/* Debug state indicator */}
        {debugEnabled && (
          <div className="flex flex-col items-center gap-3">
            <div className="text-white/50 text-sm font-mono">
              Base: {effectiveState} | Playing: {isActuallyPlayingAudio ? 'YES' : 'NO'} | Audio: {(audioLevel * 100).toFixed(0)}%
              {toolOverlayActive && <span className="text-purple-400"> | Tool Overlay: ON</span>}
            </div>

            {/* Debug controls */}
            <div className="flex flex-wrap gap-2 justify-center max-w-xl">
              <button
                onClick={() => {
                  setOrbState(OrbState.IDLE)
                  setIsActuallyPlayingAudio(false)
                  toolUseEndTimeRef.current = 0
                }}
                className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
              >
                → IDLE
              </button>
              <button
                onClick={() => {
                  setOrbState(OrbState.LISTENING)
                  setIsMuted(false)
                  isMutedRef.current = false
                  setIsActuallyPlayingAudio(false)
                  toolUseEndTimeRef.current = 0
                }}
                className="px-3 py-1 text-xs bg-green-700 hover:bg-green-600 text-white rounded"
              >
                → LISTENING
              </button>
              <button
                onClick={() => {
                  setOrbState(OrbState.THINKING)
                  setIsActuallyPlayingAudio(false)
                  toolUseEndTimeRef.current = 0
                }}
                className="px-3 py-1 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded"
              >
                → THINKING
              </button>
              <button
                onClick={() => {
                  setIsActuallyPlayingAudio(true)
                  toolUseEndTimeRef.current = 0
                }}
                className="px-3 py-1 text-xs bg-orange-700 hover:bg-orange-600 text-white rounded"
              >
                → SPEAKING (start)
              </button>
              <button
                onClick={() => {
                  setIsActuallyPlayingAudio(false)
                }}
                className="px-3 py-1 text-xs bg-orange-900 hover:bg-orange-800 text-white rounded"
              >
                SPEAKING (stop)
              </button>
              <button
                onClick={() => {
                  console.log('[DEBUG Button] Activating Tool Overlay')
                  setIsUsingTool(true)
                  toolUseEndTimeRef.current = 0  // Active tool use
                  console.log('[DEBUG Button] Tool overlay activated:', {
                    isUsingTool: true,
                    toolUseEndTime: 0,
                  })
                }}
                className="px-3 py-1 text-xs bg-purple-700 hover:bg-purple-600 text-white rounded"
              >
                Tool Overlay ON
              </button>
              <button
                onClick={() => {
                  const now = Date.now()
                  console.log('[DEBUG Button] Starting Tool Overlay Linger')
                  setIsUsingTool(true)
                  toolUseEndTimeRef.current = now  // Start linger countdown
                  console.log('[DEBUG Button] Tool overlay linger started:', {
                    isUsingTool: true,
                    toolUseEndTime: now,
                  })
                }}
                className="px-3 py-1 text-xs bg-purple-900 hover:bg-purple-800 text-white rounded"
              >
                Tool Overlay (linger)
              </button>
              <button
                onClick={() => {
                  console.log('[DEBUG Button] Deactivating Tool Overlay')
                  setIsUsingTool(false)
                  toolUseEndTimeRef.current = 0
                  console.log('[DEBUG Button] Tool overlay deactivated')
                }}
                className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
              >
                Tool Overlay OFF
              </button>
              <button
                onClick={() => {
                  // Simulate audio level fluctuation
                  const fluctuate = () => {
                    const level = Math.random() * 0.8 + 0.2
                    setAudioLevel(level)
                  }
                  // Run for 3 seconds
                  const interval = setInterval(fluctuate, 100)
                  setTimeout(() => {
                    clearInterval(interval)
                    setAudioLevel(0)
                  }, 3000)
                }}
                className="px-3 py-1 text-xs bg-yellow-700 hover:bg-yellow-600 text-white rounded"
              >
                Simulate Audio (3s)
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-6">
        {/* Mute/Unmute button */}
        <button
          type="button"
          onClick={async () => {
            const next = !isMuted
            setIsMuted(next)
            isMutedRef.current = next

            // Update orb state based on mute status
            if (next) {
              // Muting - go to idle unless actively speaking/thinking
              if (orbState !== OrbState.SPEAKING && orbState !== OrbState.THINKING) {
                setOrbState(OrbState.IDLE)
              }
              // Note: tool overlay remains active if it was on - it's independent of mute state
            } else {
              // Unmuting - go to listening
              setOrbState(OrbState.LISTENING)
              try { await audioContextRef.current?.resume() } catch {}
            }
          }}
          className="h-16 w-16 rounded-full bg-tweetBlue hover:brightness-110 flex items-center justify-center shadow-lg"
          aria-label={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? (
            <svg width="24" height="24" viewBox="0 0 24 24" className="text-white" aria-hidden="true">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" fill="currentColor"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/>
              <line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" className="text-white" aria-hidden="true">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" fill="currentColor"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/>
            </svg>
          )}
        </button>

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="h-16 w-16 rounded-full bg-bgCardAlt hover:bg-bgCard flex items-center justify-center shadow-lg"
          aria-label="Close voice mode"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" className="text-white" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
        </button>
        </div>
      </div>
    </div>
  )
}
