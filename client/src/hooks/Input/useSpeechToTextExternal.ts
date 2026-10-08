import { useState, useRef } from 'react';
import { useRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useSpeechToTextMutation } from '~/data-provider';
import useErrorToast from '~/hooks/useErrorToast';
import { useLocalize } from '~/hooks';
import store from '~/store';

export const getBestSupportedMimeType = (
  isTypeSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
) => {
  const types = [
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/webm;codecs=opus',
    'audio/mp4',
  ];

  for (const type of types) {
    if (isTypeSupported(type)) {
      return type;
    }
  }

  const ua = userAgent.toLowerCase();
  if (ua.indexOf('safari') !== -1 && ua.indexOf('chrome') === -1) {
    return 'audio/mp4';
  } else if (ua.indexOf('firefox') !== -1) {
    return 'audio/ogg';
  }

  return 'audio/webm';
};

const useSpeechToTextExternal = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => void,
) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const showErrorToast = useErrorToast();
  const audioStream = useRef<MediaStream | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const audioChunksRef = useRef<Blob[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isRequestBeingMade, setIsRequestBeingMade] = useState(false);
  const [audioMimeType, setAudioMimeType] = useState<string>(() => getBestSupportedMimeType());

  const [minDecibels] = useRecoilState(store.decibelValue);
  const [autoSendText] = useRecoilState(store.autoSendText);
  const [languageSTT] = useRecoilState<string>(store.languageSTT);
  const [speechToText] = useRecoilState<boolean>(store.speechToText);
  const [autoTranscribeAudio] = useRecoilState<boolean>(store.autoTranscribeAudio);

  const { mutate: processAudio, isLoading: isProcessing } = useSpeechToTextMutation({
    onSuccess: (data) => {
      const extractedText = data.text;
      setText(extractedText);
      setIsRequestBeingMade(false);

      if (autoSendText > -1 && speechToText && extractedText.length > 0) {
        setTimeout(() => {
          onTranscriptionComplete(extractedText);
        }, autoSendText * 1000);
      }
    },
    onError: (error: unknown) => {
      showErrorToast(error, 'com_nav_stt_process_error');
      setIsRequestBeingMade(false);
    },
  });

  const getFileExtension = (mimeType: string) => {
    if (mimeType.includes('mp4')) {
      return 'm4a';
    } else if (mimeType.includes('ogg')) {
      return 'ogg';
    } else if (mimeType.includes('wav')) {
      return 'wav';
    } else {
      return 'webm';
    }
  };

  const cleanup = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current = null;
    }
  };

  const getMicrophonePermission = async () => {
    try {
      const streamData = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      audioStream.current = streamData ?? null;
    } catch {
      audioStream.current = null;
    }
  };

  const handleStop = () => {
    if (audioChunksRef.current.length > 0) {
      const audioBlob = new Blob(audioChunksRef.current, { type: audioMimeType });
      const fileExtension = getFileExtension(audioMimeType);

      audioChunksRef.current = [];

      const formData = new FormData();
      formData.append('audio', audioBlob, `audio.${fileExtension}`);
      if (languageSTT) {
        formData.append('language', languageSTT);
      }
      setIsRequestBeingMade(true);
      cleanup();
      processAudio(formData);
    } else {
      showToast({ message: localize('com_nav_stt_too_short'), status: 'warning' });
    }
  };

  const monitorSilence = (stream: MediaStream, stopRecording: () => void) => {
    const audioContext = new AudioContext();
    const audioStreamSource = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.minDecibels = minDecibels;
    audioStreamSource.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const domainData = new Uint8Array(bufferLength);
    let lastSoundTime = Date.now();

    const detectSound = () => {
      analyser.getByteFrequencyData(domainData);
      const isSoundDetected = domainData.some((value) => value > 0);

      if (isSoundDetected) {
        lastSoundTime = Date.now();
      }

      const timeSinceLastSound = Date.now() - lastSoundTime;
      const isOverSilenceThreshold = timeSinceLastSound > 3000;

      if (isOverSilenceThreshold) {
        stopRecording();
        return;
      }

      animationFrameIdRef.current = window.requestAnimationFrame(detectSound);
    };

    animationFrameIdRef.current = window.requestAnimationFrame(detectSound);
  };

  const startRecording = async () => {
    if (isRequestBeingMade) {
      showToast({ message: localize('com_nav_stt_request_pending'), status: 'warning' });
      return;
    }

    if (!audioStream.current) {
      await getMicrophonePermission();
    }

    if (audioStream.current) {
      try {
        audioChunksRef.current = [];
        const bestMimeType = getBestSupportedMimeType();
        setAudioMimeType(bestMimeType);

        mediaRecorderRef.current = new MediaRecorder(audioStream.current, {
          mimeType: audioMimeType,
        });
        mediaRecorderRef.current.addEventListener('dataavailable', (event: BlobEvent) => {
          audioChunksRef.current.push(event.data);
        });
        mediaRecorderRef.current.addEventListener('stop', handleStop);
        mediaRecorderRef.current.start(100);
        if (!audioContextRef.current && autoTranscribeAudio && speechToText) {
          monitorSilence(audioStream.current, stopRecording);
        }
        setIsListening(true);
      } catch (error) {
        console.error('[useSpeechToTextExternal] Failed to start recording', error);
        showToast({ message: localize('com_nav_stt_start_error'), status: 'error' });
      }
    } else {
      showToast({ message: localize('com_nav_stt_permission_denied'), status: 'error' });
    }
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current) {
      return;
    }

    if (mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();

      audioStream.current?.getTracks().forEach((track) => track.stop());
      audioStream.current = null;

      if (animationFrameIdRef.current !== null) {
        window.cancelAnimationFrame(animationFrameIdRef.current);
        animationFrameIdRef.current = null;
      }

      setIsListening(false);
    } else {
      showToast({ message: localize('com_nav_stt_not_recording'), status: 'error' });
    }
  };

  const externalStartRecording = () => {
    if (typeof MediaRecorder === 'undefined') {
      showToast({ message: localize('com_nav_stt_not_supported'), status: 'error' });
      return;
    }

    if (isListening) {
      showToast({ message: localize('com_nav_stt_already_listening'), status: 'warning' });
      return;
    }

    startRecording();
  };

  const externalStopRecording = () => {
    if (!isListening) {
      showToast({ message: localize('com_nav_stt_not_listening'), status: 'warning' });
      return;
    }

    stopRecording();
  };

  return {
    isListening,
    externalStopRecording,
    externalStartRecording,
    isLoading: isProcessing,
  };
};

export default useSpeechToTextExternal;
