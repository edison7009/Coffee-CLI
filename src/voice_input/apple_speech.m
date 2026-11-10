#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>
#import <dispatch/dispatch.h>
#include <stdint.h>
#include <stdbool.h>

typedef void (*CoffeeSpeechCallback)(uint64_t, uint32_t, const char *);

API_AVAILABLE(macos(10.15))
@interface CoffeeAppleSpeech : NSObject
@property uint64_t identifier;
@property CoffeeSpeechCallback callback;
@property(copy) NSString *locale;
@property BOOL cancelled;
@property(strong) SFSpeechRecognizer *recognizer;
@property(strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(strong) SFSpeechRecognitionTask *task;
- (void)begin;
- (void)append:(const int16_t *)samples count:(uint32_t)count;
- (void)finish;
- (void)close;
@end

@implementation CoffeeAppleSpeech
- (void)emit:(uint32_t)kind text:(NSString *)text {
    @synchronized(self) {
        if (!self.cancelled && self.callback) self.callback(self.identifier, kind, text.UTF8String);
    }
}
- (void)begin {
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
        dispatch_async(dispatch_get_main_queue(), ^{
            @synchronized(self) {
                if (self.cancelled) return;
                if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                    [self emit:3 text:@"speech_permission"];
                    return;
                }
                self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[[NSLocale alloc] initWithLocaleIdentifier:self.locale]];
                if (!self.recognizer || !self.recognizer.available) {
                    [self emit:3 text:@"speech_unavailable"];
                    return;
                }
                self.request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
                self.request.shouldReportPartialResults = YES;
                self.request.taskHint = SFSpeechRecognitionTaskHintDictation;
                self.request.requiresOnDeviceRecognition = self.recognizer.supportsOnDeviceRecognition;
                self.task = [self.recognizer recognitionTaskWithRequest:self.request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
                    @synchronized(self) {
                        if (self.cancelled) return;
                        if (result) {
                            [self emit:result.isFinal ? 2 : 1 text:result.bestTranscription.formattedString];
                            if (result.isFinal) { self.task = nil; return; }
                        }
                        if (error) { [self emit:3 text:@"speech_failed"]; self.task = nil; }
                    }
                }];
                [self emit:0 text:@""];
            }
        });
    }];
}
- (void)append:(const int16_t *)samples count:(uint32_t)count {
    @synchronized(self) {
        if (self.cancelled || !self.request) return;
        AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:16000 channels:1 interleaved:NO];
        AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:count];
        buffer.frameLength = count;
        for (uint32_t i = 0; i < count; i++) buffer.floatChannelData[0][i] = samples[i] / 32768.0f;
        [self.request appendAudioPCMBuffer:buffer];
    }
}
- (void)finish { @synchronized(self) { if (!self.cancelled) [self.request endAudio]; } }
- (void)close {
    @synchronized(self) {
        self.cancelled = YES;
        self.callback = NULL;
        [self.request endAudio];
        [self.task cancel];
        self.task = nil;
        self.request = nil;
        self.recognizer = nil;
    }
}
@end

bool coffee_apple_speech_available(void) {
    @autoreleasepool {
        if (@available(macOS 10.15, *)) return [SFSpeechRecognizer supportedLocales].count > 0;
        return false;
    }
}
bool coffee_apple_speech_ready(void) {
    @autoreleasepool {
        if (@available(macOS 10.15, *)) {
            if ([SFSpeechRecognizer authorizationStatus] != SFSpeechRecognizerAuthorizationStatusAuthorized ||
                [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] != AVAuthorizationStatusAuthorized) return false;
            SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] init];
            return recognizer != nil && recognizer.available;
        }
        return false;
    }
}
void *coffee_apple_speech_start(uint64_t identifier, const char *locale, CoffeeSpeechCallback callback) {
    @autoreleasepool {
        if (@available(macOS 10.15, *)) {
            CoffeeAppleSpeech *session = [[CoffeeAppleSpeech alloc] init];
            session.identifier = identifier;
            session.locale = [NSString stringWithUTF8String:locale];
            session.callback = callback;
            dispatch_async(dispatch_get_main_queue(), ^{ [session begin]; });
            return (__bridge_retained void *)session;
        }
        return NULL;
    }
}
void coffee_apple_speech_append(void *handle, const int16_t *samples, uint32_t count) {
    @autoreleasepool { if (@available(macOS 10.15, *)) [(__bridge CoffeeAppleSpeech *)handle append:samples count:count]; }
}
void coffee_apple_speech_finish(void *handle) {
    @autoreleasepool { if (@available(macOS 10.15, *)) [(__bridge CoffeeAppleSpeech *)handle finish]; }
}
void coffee_apple_speech_drop(void *handle) {
    @autoreleasepool { if (@available(macOS 10.15, *)) { CoffeeAppleSpeech *session = (__bridge_transfer CoffeeAppleSpeech *)handle; [session close]; } }
}
