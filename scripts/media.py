"""Optional local-file adapters, no network or credentials. Models must already exist locally.
ASR: python media.py asr audio.m4s output.json --duration 157 --model /local/faster-whisper-small
Frames: python media.py frames video.mp4 frame-dir --duration 157 --interval 15
Chosen moments: python media.py frames video.mp4 frame-dir --duration 157 --at 12,30.5
Frames are visual evidence for a host vision model; this script does not claim OCR or full viewing.
"""
import argparse, json, math, sys, time
from pathlib import Path

SEEK_MARGIN=2

def check_dimensions(width,height,a):
    if not (isinstance(width,int) and isinstance(height,int) and width>0 and height>0):raise RuntimeError('Invalid video dimensions')
    if a.max_short_side and min(width,height)>a.max_short_side:raise RuntimeError('Decoded short side exceeds budget')
    if a.max_long_side and max(width,height)>a.max_long_side:raise RuntimeError('Decoded long side exceeds budget')
    if a.max_pixels and width*height>a.max_pixels:raise RuntimeError('Decoded pixels exceed budget')

def check_duration(value,a):
    if not math.isfinite(value) or value<0:raise RuntimeError('Invalid decoded duration')
    if value>a.duration+1:raise RuntimeError('Decoded duration does not match source metadata')
    if a.max_seconds is not None and value>a.max_seconds:raise RuntimeError('Decoded duration exceeds configured limit')

def check_frame(frame,a,started):
    if time.monotonic()-started>a.max_wall_seconds:raise RuntimeError('Frame wall budget exceeded')
    t=float(frame.time or 0)
    check_dimensions(frame.width,frame.height,a)
    if not math.isfinite(t) or t<0:raise RuntimeError('Invalid decoded timestamp')
    if a.strict_duration:check_duration(t,a)
    if a.max_seconds is not None and t>a.max_seconds:raise RuntimeError('Decoded duration exceeds configured limit')
    return t

def write_frame(frame,t,rows,a):
    filename=f'frame-{len(rows):03d}-{t:.2f}.jpg'
    frame.to_image().save(a.output/filename,quality=90)
    rows.append({'at':t,'file':filename,'width':frame.width,'height':frame.height})

def parse_times(raw,duration):
    try:times=[float(value) for value in raw.split(',')]
    except ValueError:return None
    if not 1<=len(times)<=4 or not all(math.isfinite(value) and 0<=value<=duration for value in times):return None
    return sorted(set(times))

def frame_at(container,stream,target,a,started):
    """First frame at or after target, or the last one when the source ends first."""
    # Fragmented MP4 seeks by decode time, and a keyframe displays later than that when
    # the stream reorders frames, so aim SEEK_MARGIN early. Times ascend, so if a container
    # refuses to seek, decoding on from the current position still reaches target.
    try:container.seek(int(max(0,target-SEEK_MARGIN)/stream.time_base),stream=stream)
    except Exception:pass
    found=None
    for frame in container.decode(video=0):
        t=check_frame(frame,a,started)
        if t>a.duration:break
        found=(frame,t)
        if t>=target:break
    return found

def bind_text_values(argv):
    """Source titles reach these flags and may start with a dash; never read one as an option."""
    bound=[];i=0
    while i<len(argv):
        if argv[i] in ('--initial-prompt','--hotwords') and i+1<len(argv):
            bound.append(argv[i]+'='+argv[i+1]);i+=2
        else:
            bound.append(argv[i]);i+=1
    return bound

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=['asr','frames'])
    p.add_argument('input',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--duration',type=float,required=True)
    p.add_argument('--max-seconds',type=float)
    p.add_argument('--max-wall-seconds',type=float,default=900)
    p.add_argument('--model',type=Path);p.add_argument('--interval',type=float,default=15)
    p.add_argument('--max-short-side',type=int,default=0);p.add_argument('--max-long-side',type=int,default=0)
    p.add_argument('--max-pixels',type=int,default=0)
    p.add_argument('--strict-duration',action='store_true')
    p.add_argument('--at')
    p.add_argument('--initial-prompt');p.add_argument('--hotwords');p.add_argument('--vad',action='store_true')
    a=p.parse_args(bind_text_values(sys.argv[1:]))
    if not a.input.is_file() or not (math.isfinite(a.duration) and 0<a.duration<=9007199254740991):p.error('Existing local file and positive finite representable duration required')
    if a.max_seconds is not None and not (math.isfinite(a.max_seconds) and 0<a.max_seconds<=9007199254740991 and a.duration<=a.max_seconds):p.error('Duration exceeds optional configured limit or limit is invalid')
    times=None
    if a.at is not None:
        times=parse_times(a.at,a.duration)
        if a.mode!='frames' or times is None:p.error('--at requires frames mode and 1-4 times within the source duration')
    started=time.monotonic()
    if a.mode=='asr':
        if not a.model or not a.model.is_dir():p.error('Existing local faster-whisper model directory required; no model downloads')
        from faster_whisper import WhisperModel
        model=WhisperModel(str(a.model),device='cpu',compute_type='int8',local_files_only=True)
        hints={}
        if a.initial_prompt:hints['initial_prompt']=a.initial_prompt
        if a.hotwords:hints['hotwords']=a.hotwords
        result,info=model.transcribe(str(a.input),beam_size=1,vad_filter=a.vad,condition_on_previous_text=False,**hints)
        check_duration(info.duration,a)
        rows=[]
        for s in result:
            if time.monotonic()-started>a.max_wall_seconds:raise RuntimeError('ASR wall budget exceeded')
            # Only reconcile an ordered tail inside the already accepted decoded duration.
            # Implausible or reversed times remain invalid for the strict importer.
            start=s.start
            if a.duration<start<=info.duration and start<=s.end:start=a.duration
            rows.append({'start':start,'end':min(s.end,a.duration),'text':s.text.strip()})
        a.output.parent.mkdir(parents=True,exist_ok=True)
        a.output.write_text(json.dumps({'route':'A3','duration':a.duration,'segments':rows,'note':'AI-ASR, not verbatim; proper names need source checking.'},ensure_ascii=False,indent=2),encoding='utf8')
    else:
        if a.interval<1:p.error('interval must be >=1 second')
        import av
        a.output.mkdir(parents=True,exist_ok=True)
        timestamps=[];next_time=0
        with av.open(str(a.input)) as container:
            if a.strict_duration:
                if not container.streams.video:raise RuntimeError('No video stream')
                stream=container.streams.video[0]
                check_dimensions(stream.codec_context.width,stream.codec_context.height,a)
                decoded_duration=float(stream.duration*stream.time_base) if stream.duration is not None and stream.time_base else float(container.duration/av.time_base) if container.duration is not None else None
                if decoded_duration is not None:check_duration(decoded_duration,a)
            if times:
                if not container.streams.video:raise RuntimeError('No video stream')
                for target in times:
                    found=frame_at(container,container.streams.video[0],target,a,started)
                    if found is None:raise RuntimeError('No decoded frame for chosen time')
                    if all(row['at']!=found[1] for row in timestamps):write_frame(found[0],found[1],timestamps,a)
            else:
                for frame in container.decode(video=0):
                    t=check_frame(frame,a,started)
                    if t>a.duration:break
                    if t>=next_time and len(timestamps)<40:
                        write_frame(frame,t,timestamps,a);next_time=t+a.interval
        (a.output/'manifest.json').write_text(json.dumps({'route':'frame','duration':a.duration,'sampling':'chosen' if times else 'uniform; may miss pages or motion','frames':timestamps,'next':'Host vision model may transcribe visible text to import JSON; preserve timestamps and uncertainty.'},ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'mode':a.mode,'output':str(a.output),'elapsed_seconds':round(time.monotonic()-started,3)}))
if __name__=='__main__':main()
