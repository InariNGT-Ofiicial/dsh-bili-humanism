"""Optional local-file adapters, no network or credentials. Models must already exist locally.
ASR: python media.py asr audio.m4s output.json --duration 157 --model /local/faster-whisper-small
Frames: python media.py frames video.mp4 frame-dir --duration 157 --interval 15
Frames are visual evidence for a host vision model; this script does not claim OCR or full viewing.
"""
import argparse, json, math, time
from pathlib import Path

def check_dimensions(width,height,a):
    if not (isinstance(width,int) and isinstance(height,int) and width>0 and height>0):raise RuntimeError('Invalid video dimensions')
    if a.max_short_side and min(width,height)>a.max_short_side:raise RuntimeError('Decoded short side exceeds budget')
    if a.max_long_side and max(width,height)>a.max_long_side:raise RuntimeError('Decoded long side exceeds budget')
    if a.max_pixels and width*height>a.max_pixels:raise RuntimeError('Decoded pixels exceed budget')

def check_duration(value,a):
    if not math.isfinite(value) or value<0:raise RuntimeError('Invalid decoded duration')
    if value>a.duration+1:raise RuntimeError('Decoded duration does not match source metadata')
    if a.max_seconds is not None and value>a.max_seconds:raise RuntimeError('Decoded duration exceeds configured limit')

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
    a=p.parse_args()
    if not a.input.is_file() or not (math.isfinite(a.duration) and 0<a.duration<=9007199254740991):p.error('Existing local file and positive finite representable duration required')
    if a.max_seconds is not None and not (math.isfinite(a.max_seconds) and 0<a.max_seconds<=9007199254740991 and a.duration<=a.max_seconds):p.error('Duration exceeds optional configured limit or limit is invalid')
    started=time.monotonic()
    if a.mode=='asr':
        if not a.model or not a.model.is_dir():p.error('Existing local faster-whisper model directory required; no model downloads')
        from faster_whisper import WhisperModel
        model=WhisperModel(str(a.model),device='cpu',compute_type='int8',local_files_only=True)
        result,info=model.transcribe(str(a.input),beam_size=1,vad_filter=False,condition_on_previous_text=False)
        check_duration(info.duration,a)
        rows=[]
        for s in result:
            if time.monotonic()-started>a.max_wall_seconds:raise RuntimeError('ASR wall budget exceeded')
            # check_duration lets audio run a second past the metadata, so a tail segment may start there too.
            start=min(s.start,a.duration)
            rows.append({'start':start,'end':max(start,min(s.end,a.duration)),'text':s.text.strip()})
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
            for frame in container.decode(video=0):
                if time.monotonic()-started>a.max_wall_seconds:raise RuntimeError('Frame wall budget exceeded')
                t=float(frame.time or 0)
                check_dimensions(frame.width,frame.height,a)
                if not math.isfinite(t) or t<0:raise RuntimeError('Invalid decoded timestamp')
                if a.strict_duration:check_duration(t,a)
                if a.max_seconds is not None and t>a.max_seconds:raise RuntimeError('Decoded duration exceeds configured limit')
                if t>a.duration:break
                if t>=next_time and len(timestamps)<40:
                    filename=f'frame-{len(timestamps):03d}-{t:.2f}.jpg'
                    frame.to_image().save(a.output/filename,quality=90)
                    timestamps.append({'at':t,'file':filename,'width':frame.width,'height':frame.height});next_time=t+a.interval
        (a.output/'manifest.json').write_text(json.dumps({'route':'frame','duration':a.duration,'sampling':'uniform; may miss pages or motion','frames':timestamps,'next':'Host vision model may transcribe visible text to import JSON; preserve timestamps and uncertainty.'},ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'mode':a.mode,'output':str(a.output),'elapsed_seconds':round(time.monotonic()-started,3)}))
if __name__=='__main__':main()
